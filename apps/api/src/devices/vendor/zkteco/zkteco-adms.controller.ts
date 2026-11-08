import { Controller, Get, Logger, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { PrismaService } from '../../../common/prisma.service';
import { RateLimitService } from '../../../common/rate-limit.service';
import { BiometricIngestService, IngestingDevice } from '../biometric-ingest.service';
import { DeviceSyncService } from '../device-sync.service';
import {
  IGNORED_TABLES,
  buildHandshake,
  formatCommand,
  parseAttlog,
  parseDeviceCommandResults,
} from './zkteco-protocol';

const SERIAL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Terminals poll getrequest every `Delay` seconds (10) plus uploads; this leaves wide headroom. */
const RATE_LIMIT_PER_MINUTE = 120;
const INGEST_CHUNK = 500;

interface AdmsDevice extends IngestingDevice {
  timezone: string;
}

class AdmsRejection extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * ZKTeco ADMS ("iclock") endpoints, mounted at /iclock outside the /api/v1 prefix because
 * firmware hardcodes these paths. Responses are plain text. ADMS has no per-request secret, so
 * the device is identified by serial number and optionally pinned to source IPs.
 */
@ApiExcludeController()
@Controller('iclock')
export class ZktecoAdmsController {
  private readonly logger = new Logger(ZktecoAdmsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: BiometricIngestService,
    private readonly sync: DeviceSyncService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get('cdata')
  async handshake(@Query('SN') sn: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.respond(res, sn, req, async (device, serial) => {
      await this.touch(device);
      return buildHandshake(serial);
    });
  }

  @Post('cdata')
  async upload(
    @Query('SN') sn: unknown,
    @Query('table') table: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.respond(res, sn, req, async (device) => {
      const tableName = typeof table === 'string' ? table.toUpperCase() : '';
      if (tableName !== 'ATTLOG') {
        // OPERLOG/BIODATA/USERINFO are acknowledged so the terminal stops resending them.
        // Unknown tables get the same answer: the terminal must not retry forever.
        if (!IGNORED_TABLES.has(tableName)) this.logger.debug(`Ignoring table "${tableName.slice(0, 20)}"`);
        await this.touch(device);
        return 'OK';
      }
      const { events, received, skipped } = parseAttlog(bodyText(req), device.timezone);
      if (skipped > 0) this.logger.warn(`Device ${device.id}: skipped ${skipped} malformed ATTLOG line(s)`);
      for (let i = 0; i < events.length; i += INGEST_CHUNK) {
        await this.ingest.ingest(
          { id: device.id, societyId: device.societyId, protocol: device.protocol },
          events.slice(i, i + INGEST_CHUNK),
        );
      }
      if (events.length === 0) await this.touch(device);
      return `OK: ${received}`;
    });
  }

  @Get('getrequest')
  async getRequest(@Query('SN') sn: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.respond(res, sn, req, async (device) => {
      await this.touch(device);
      const commands = await this.sync.pull(device.id);
      const lines: string[] = [];
      for (const command of commands) {
        const line = formatCommand(command);
        if (line) {
          lines.push(line);
        } else {
          await this.sync.acknowledge(device.id, command.id, false, 'Command not supported by ZKTeco ADMS');
        }
      }
      return lines.length > 0 ? lines.join('\n') : 'OK';
    });
  }

  @Post('devicecmd')
  async deviceCommand(@Query('SN') sn: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.respond(res, sn, req, async (device) => {
      for (const result of parseDeviceCommandResults(bodyText(req))) {
        try {
          await this.sync.acknowledge(
            device.id,
            result.commandId,
            result.success,
            result.success ? undefined : `Device returned ${result.returnCode}`,
          );
        } catch (error) {
          // A stale or foreign id must not make the terminal resend its whole result batch.
          this.logger.warn(`Device ${device.id}: ack for unknown command ignored (${errorName(error)})`);
        }
      }
      return 'OK';
    });
  }

  private async respond(
    res: Response,
    sn: unknown,
    req: Request,
    handler: (device: AdmsDevice, serial: string) => Promise<string>,
  ): Promise<void> {
    res.type('text/plain');
    try {
      const serial = typeof sn === 'string' && SERIAL_PATTERN.test(sn) ? sn : null;
      if (!serial) throw new AdmsRejection(401, 'ERROR: unknown device');
      // Keyed on serial AND source IP: a spoofer elsewhere cannot exhaust a real terminal's bucket.
      const hit = await this.rateLimit.hit(`iclock:${serial}:${req.ip ?? 'unknown'}`, RATE_LIMIT_PER_MINUTE, 60);
      if (!hit.allowed) throw new AdmsRejection(429, 'ERROR: rate limited');
      const device = await this.authenticate(serial, req.ip);
      res.status(200).send(await handler(device, serial));
    } catch (error) {
      if (error instanceof AdmsRejection) {
        res.status(error.status).send(error.message);
        return;
      }
      // Never include the request body: it carries PINs and names.
      this.logger.error(`ADMS request failed: ${errorName(error)}`);
      res.status(500).send('ERROR: internal');
    }
  }

  private async authenticate(serial: string, ip: string | undefined): Promise<AdmsDevice> {
    const device = await this.prisma.device.findUnique({
      where: { deviceUid: serial },
      select: {
        id: true,
        societyId: true,
        protocol: true,
        status: true,
        pushAllowedIps: true,
        society: { select: { timezone: true } },
      },
    });
    // Identical response for unknown/wrong-protocol/disabled so serials cannot be enumerated.
    if (!device || device.protocol !== 'ZKTECO_ADMS' || device.status !== 'ACTIVE') {
      throw new AdmsRejection(401, 'ERROR: unknown device');
    }
    // ADMS carries no secret, so the source IP is the only proof of identity: fail closed when
    // none is pinned rather than accept anyone who knows (or guesses) a serial number.
    if (device.pushAllowedIps.length === 0 || !ip || !device.pushAllowedIps.includes(normalizeIp(ip))) {
      this.logger.warn(`Device ${device.id}: push from non-allowlisted IP rejected`);
      throw new AdmsRejection(401, 'ERROR: unknown device');
    }
    return {
      id: device.id,
      societyId: device.societyId,
      protocol: device.protocol,
      timezone: device.society.timezone,
    };
  }

  private async touch(device: AdmsDevice): Promise<void> {
    await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  }
}

function bodyText(req: Request): string {
  return typeof req.body === 'string' ? req.body : '';
}

/** Express reports IPv4 clients on dual-stack sockets as ::ffff:a.b.c.d. */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
