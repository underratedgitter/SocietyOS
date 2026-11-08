import * as fs from 'fs';
import * as path from 'path';

export type Cursor = string | number;

export interface StateStore {
  load(): Cursor | null;
  save(cursor: Cursor): void;
}

/** Cursor file written as temp + fsync + rename so a crash never leaves a torn file. */
export class FileStateStore implements StateStore {
  constructor(private readonly file: string) {}

  load(): Cursor | null {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'cursor' in parsed) {
      const c = (parsed as { cursor: unknown }).cursor;
      if (typeof c === 'string' || typeof c === 'number') return c;
    }
    throw new Error(`state file ${this.file} is corrupt; fix or delete it to restart from initialCursor`);
  }

  save(cursor: Cursor): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify({ cursor, updatedAt: new Date().toISOString() }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}
