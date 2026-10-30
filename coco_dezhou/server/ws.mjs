/**
 * 零依赖的 WebSocket 服务端实现（RFC 6455 子集）：
 * 握手、文本/二进制帧、分片、ping/pong、关闭帧。
 * 只为本项目服务，未实现扩展协商与压缩。
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 512 * 1024;

export class WsConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.closed = false;
    this.fragments = [];
    this.fragOpcode = 0;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._parse();
    });
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());
    socket.on('error', () => this._finish());

    if (this.buffer.length) this._parse();
  }

  get alive() {
    return !this.closed && !this.socket.destroyed;
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _parse() {
    while (!this.closed) {
      const buf = this.buffer;
      if (buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(MAX_PAYLOAD)) {
          this.close(1009, 'too large');
          return;
        }
        len = Number(big);
        offset += 8;
      }
      if (len > MAX_PAYLOAD) {
        this.close(1009, 'too large');
        return;
      }

      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;

      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this.buffer = buf.subarray(offset + len);

      if (opcode === 0x8) {
        this._sendRaw(0x8, payload.subarray(0, 2));
        this._finish();
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
        return;
      }
      if (opcode === 0x9) {
        this._sendRaw(0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        this.emit('pong');
        continue;
      }

      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) this._deliver(this.fragOpcode, Buffer.concat(this.fragments));
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.fragments = [payload];
          this.fragOpcode = opcode;
          continue;
        }
        this._deliver(opcode, payload);
        continue;
      }
    }
  }

  _deliver(opcode, payload) {
    this.fragments = [];
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  _sendRaw(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._finish();
    }
  }

  send(text) {
    if (typeof text !== 'string') text = JSON.stringify(text);
    this._sendRaw(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this._sendRaw(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this._sendRaw(0x8, payload);
    this._finish();
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }
}

/** 处理 HTTP upgrade，握手成功后回调 onConnection(conn, req) */
export function acceptUpgrade(req, socket, head, onConnection) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers['upgrade'] || '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const conn = new WsConnection(socket, head);
  onConnection(conn, req);
}
