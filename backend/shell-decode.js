// ============================================================
// shell-decode.js — Correct decoding of shell/console command output
// captured via child_process pipes (Windows CJK mojibake fix).
// ============================================================
//
// On Windows, legacy console utilities (tracert, ping, netstat, ipconfig,
// systeminfo, ...) write to a *pipe* using the system OEM code page
// (GBK / CP936 on zh-CN). Node's default exec decoding is UTF-8, so CJK
// text comes out as mojibake (e.g. "正在" -> "����").
//
// Strategy (applied to the full captured buffer):
//   1. If the raw bytes are valid UTF-8 -> decode as UTF-8
//      (git / node / python / modern tools + plain ASCII).
//   2. Else -> decode with the system OEM code page (GBK on zh-CN),
//      which is what legacy console tools actually emit.
//
// NOTE: the common `chcp 65001` trick does NOT help here — it only changes
// the *console screen* code page; pipe output from these tools stays OEM.

import { execSync } from 'child_process';

const _utf8Fatal = new TextDecoder('utf-8', { fatal: true });

let _oemDecoder = null; // lazily built, then cached

function getOemDecoder() {
  if (_oemDecoder !== null) return _oemDecoder;
  _oemDecoder = _utf8Fatal; // safe default
  if (process.platform === 'win32') {
    try {
      // `chcp` prints "Active code page: 936" in the OEM code page;
      // the digits are ASCII-safe, so we can parse them out reliably.
      const raw = execSync('chcp', { encoding: 'buffer', windowsHide: true });
      const m = /(\d+)/.exec(raw.toString('latin1'));
      const cp = m ? parseInt(m[1], 10) : 936;
      const map = { 936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 65001: 'utf-8' };
      const label = map[cp] || (cp >= 65000 ? 'utf-8' : 'gbk');
      _oemDecoder = new TextDecoder(label); // throws on unsupported label -> caught below
    } catch {
      _oemDecoder = _utf8Fatal;
    }
  }
  return _oemDecoder;
}

/**
 * Decode a captured command output (Buffer from encoding:'buffer', or string).
 * @param {Buffer|string|null|undefined} buf
 * @returns {string}
 */
export function decodeShell(buf) {
  if (!buf) return '';
  if (typeof buf === 'string') return buf; // already decoded (defensive)
  if (buf.length === 0) return '';
  try {
    return _utf8Fatal.decode(buf); // valid UTF-8 path (most tools + ASCII)
  } catch {
    const dec = getOemDecoder();
    if (dec === _utf8Fatal) return buf.toString('utf8');
    try {
      return dec.decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}
