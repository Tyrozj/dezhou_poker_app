/**
 * 持久化层：把房间注册表和每手战绩落到本地文件。
 * 两张"表"的字段设计刻意与 CoCo 云数据表一致（见 docs/CoCo接入方案.md），
 * 之后把 FileStore 换成 CocoTableStore（调用云数据表积木/HTTP 接口）即可无缝迁移。
 *
 *   房间表 room  : 房间号 房间名 上限 起始筹码 小盲 大盲 状态 房主 更新时间
 *   战绩表 hand  : 房间号 局号 时间 公共牌 赢家 底池
 */

import fs from 'node:fs';
import path from 'node:path';

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.roomsFile = path.join(dir, 'rooms.json');
    this.handsFile = path.join(dir, 'hands.jsonl');
    this.rooms = this._loadRooms();
    this._dirty = false;
    this._timer = null;
  }

  _loadRooms() {
    try {
      const raw = fs.readFileSync(this.roomsFile, 'utf8');
      const arr = JSON.parse(raw);
      return Object.fromEntries(arr.map((r) => [r.code, r]));
    } catch {
      return {};
    }
  }

  /** 房间表：新增/更新一行 */
  upsertRoom(row) {
    this.rooms[row.code] = { ...this.rooms[row.code], ...row };
    this._flushSoon();
  }

  /** 房间表：删除一行 */
  removeRoom(code) {
    if (this.rooms[code]) {
      delete this.rooms[code];
      this._flushSoon();
    }
  }

  /** 房间表：全部行（对应积木「查询云数据表」） */
  roomRows() {
    return Object.values(this.rooms);
  }

  /** 战绩表：新增一行 */
  insertHand(record) {
    try {
      fs.appendFileSync(this.handsFile, JSON.stringify(record) + '\n');
    } catch (err) {
      console.error('[store] 写入战绩失败', err.message);
    }
  }

  /** 最近战绩（用于排行榜/复盘） */
  recentHands(n = 50) {
    try {
      const raw = fs.readFileSync(this.handsFile, 'utf8').trim();
      if (!raw) return [];
      const lines = raw.split('\n');
      return lines.slice(-n).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  _flushSoon() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 400);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.writeFileSync(this.roomsFile, JSON.stringify(Object.values(this.rooms), null, 2));
    } catch (err) {
      console.error('[store] 写入房间表失败', err.message);
    }
  }
}
