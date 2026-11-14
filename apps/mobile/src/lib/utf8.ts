// UTF-8 encoder/decoder used when Hermes lacks a working TextEncoder/TextDecoder (see polyfills.ts).

export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0) ?? 0xfffd;
    // lone surrogates become U+FFFD, like the native encoder
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}

/** WHATWG UTF-8 decode (non-streaming), with the same error rules as the spec's decoder. */
export function decodeUtf8(bytes: Uint8Array, fatal: boolean, ignoreBOM: boolean): string {
  const points: number[] = [];
  let out = '';
  const flush = () => {
    out += String.fromCodePoint(...points);
    points.length = 0;
  };
  const push = (cp: number) => {
    points.push(cp);
    if (points.length >= 4096) flush();
  };
  const bad = () => {
    if (fatal) throw new TypeError('The encoded data was not valid utf-8');
    push(0xfffd);
  };
  let i = 0;
  if (!ignoreBOM && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length) {
    const lead = bytes[i]!;
    if (lead < 0x80) {
      push(lead);
      i += 1;
      continue;
    }
    let need = 0;
    let cp = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) {
      need = 1;
      cp = lead & 0x1f;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      cp = lead & 0x0f;
      if (lead === 0xe0) lower = 0xa0;
      if (lead === 0xed) upper = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      cp = lead & 0x07;
      if (lead === 0xf0) lower = 0x90;
      if (lead === 0xf4) upper = 0x8f;
    } else {
      bad();
      i += 1;
      continue;
    }
    let seen = 1;
    let ok = true;
    for (; seen <= need; seen++) {
      const next = bytes[i + seen];
      if (next === undefined || next < lower || next > upper) {
        ok = false;
        break;
      }
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (next & 0x3f);
    }
    if (!ok) {
      // the offending byte is not consumed; it starts the next sequence
      bad();
      i += seen;
      continue;
    }
    push(cp);
    i += need + 1;
  }
  flush();
  return out;
}

function toBytes(input?: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (!input) return new Uint8Array();
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

export class Utf8Encoder {
  readonly encoding = 'utf-8';
  encode(text = ''): Uint8Array {
    return encodeUtf8(text);
  }
}

export class Utf8Decoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  constructor(label = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(label.toLowerCase())) {
      throw new RangeError(`unsupported encoding ${label}`);
    }
    this.fatal = options.fatal === true;
    this.ignoreBOM = options.ignoreBOM === true;
  }
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    return decodeUtf8(toBytes(input), this.fatal, this.ignoreBOM);
  }
}
