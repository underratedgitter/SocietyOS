import { Controller, HttpCode, Post, Req, Res, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthedRequest } from '../../auth/jwt-auth.guard';
import { AppException } from '../../common/app.exception';
import { PrismaService } from '../../common/prisma.service';
import { BiometricIngestService, IngestingDevice } from './biometric-ingest.service';
import { ParseResult } from './parse-result';
import { PUSH_MAX_BODY_BYTES, PushDeviceGuard, PushProtocol } from './push-device.guard';
import { HikvisionMultipartPart, parseHikvisionJson, parseHikvisionMultipart } from './hikvision/hikvision-event.parser';
import { parseDahuaEvents } from './dahua/dahua-event.parser';

/** Shape of the in-memory file multer hands over (memory storage is multer's default: nothing hits disk). */
interface UploadedPart {
  fieldname: string;
  mimetype: string;
  buffer: Buffer;
}

/** Multer limits: image parts are buffered in memory only, then dropped with the request. */
const MULTIPART_LIMITS = { fileSize: PUSH_MAX_BODY_BYTES, files: 4, fields: 16, parts: 24, fieldSize: 256 * 1024 };

/** Reads a body no parser consumed (text/plain, key=value) with a hard size cap. */
async function readRawBody(req: Request): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > PUSH_MAX_BODY_BYTES) {
      throw AppException.badRequest('PUSH_BODY_TOO_LARGE', 'Request body too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isMultipart(req: Request): boolean {
  return (req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/');
}

/** Offset of an IANA zone from UTC in minutes at `at` (e.g. Asia/Kolkata -> 330); 0 if unknown. */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? '');
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  } catch {
    return 0;
  }
}

/**
 * Cloud endpoints for Hikvision ISAPI HTTP listening and Dahua event upload. The device token is
 * in the path because these terminals cannot send an Authorization header; nginx redacts it from
 * access logs. Bodies (and any pictures in them) are parsed in memory and never persisted or logged.
 */
@ApiExcludeController()
@Controller('device-api/push')
export class VendorPushController {
  constructor(
    private readonly ingest: BiometricIngestService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':token/hikvision')
  @HttpCode(200)
  @PushProtocol('HIKVISION_ISAPI')
  @UseGuards(PushDeviceGuard)
  @UseInterceptors(AnyFilesInterceptor({ limits: MULTIPART_LIMITS }))
  async hikvision(
    @Req() req: AuthedRequest,
    @UploadedFiles() files: UploadedPart[] | undefined,
  ): Promise<{ statusCode: number; statusString: string; subStatusCode: string }> {
    let parsed: ParseResult;
    if (isMultipart(req)) {
      const parts: HikvisionMultipartPart[] = [];
      const fields: Record<string, unknown> = req.body && typeof req.body === 'object' ? req.body : {};
      for (const [name, value] of Object.entries(fields)) {
        if (typeof value === 'string') parts.push({ name, data: value });
      }
      for (const file of files ?? []) parts.push({ name: file.fieldname, mimeType: file.mimetype, data: file.buffer });
      parsed = parseHikvisionMultipart(parts);
    } else {
      parsed = parseHikvisionJson(req.body ?? (await readRawBody(req)));
    }
    await this.record(req, parsed);
    return { statusCode: 1, statusString: 'OK', subStatusCode: 'ok' };
  }

  @Post(':token/dahua')
  @HttpCode(200)
  @PushProtocol('DAHUA_HTTP')
  @UseGuards(PushDeviceGuard)
  async dahua(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<string> {
    const body: unknown = req.body && Object.keys(req.body as object).length > 0 ? req.body : await readRawBody(req);
    const society = await this.prisma.society.findUnique({
      where: { id: req.device!.societyId },
      select: { timezone: true },
    });
    const localOffsetMinutes = zoneOffsetMinutes(society?.timezone ?? 'UTC', new Date());
    await this.record(req, parseDahuaEvents(body, { localOffsetMinutes }));
    res.type('text/plain');
    return 'OK';
  }

  private async record(req: AuthedRequest, parsed: ParseResult): Promise<void> {
    if (parsed.events.length === 0) return;
    const { id, societyId, protocol } = req.device!;
    const device: IngestingDevice = { id, societyId, protocol };
    await this.ingest.ingest(device, parsed.events);
  }
}
