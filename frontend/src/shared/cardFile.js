export async function readCardJsonFromFile(file) {
  const name = file.name.toLowerCase();
  if (file.type === 'image/png' || name.endsWith('.png')) {
    return extractCardJsonFromPng(await file.arrayBuffer());
  }
  return JSON.parse(await file.text());
}

export function extractCardJsonFromPng(buffer) {
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) {
    throw new Error('PNG 文件签名无效');
  }

  const decoder = new TextDecoder();
  const chunks = [];
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) break;

    if (type === 'tEXt') {
      const chunk = bytes.slice(start, end);
      const split = chunk.indexOf(0);
      if (split >= 0) {
        chunks.push({
          keyword: decoder.decode(chunk.slice(0, split)),
          text: decoder.decode(chunk.slice(split + 1)),
        });
      }
    } else if (type === 'iTXt') {
      const parsed = parseInternationalTextChunk(bytes.slice(start, end), decoder);
      if (parsed) chunks.push(parsed);
    }

    offset = end + 4;
  }

  const preferred = chunks
    .filter(chunk => /^(chara|ccv3|character|card)$/i.test(chunk.keyword))
    .concat(chunks);

  for (const chunk of preferred) {
    const parsed = parsePossiblyEncodedJson(chunk.text);
    if (parsed) return parsed;
  }

  throw new Error('PNG 中未找到可解析的 SillyTavern 角色卡 JSON');
}

export function parseInternationalTextChunk(chunk, decoder) {
  let offset = chunk.indexOf(0);
  if (offset < 0 || offset + 3 >= chunk.length) return null;

  const keyword = decoder.decode(chunk.slice(0, offset));
  const compressionFlag = chunk[offset + 1];
  if (compressionFlag !== 0) return null;
  offset += 3;

  const languageEnd = chunk.indexOf(0, offset);
  if (languageEnd < 0) return null;
  offset = languageEnd + 1;

  const translatedEnd = chunk.indexOf(0, offset);
  if (translatedEnd < 0) return null;

  return {
    keyword,
    text: decoder.decode(chunk.slice(translatedEnd + 1)),
  };
}

export function parsePossiblyEncodedJson(value) {
  const candidates = [];
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  candidates.push(trimmed);

  try {
    candidates.push(decodeURIComponent(trimmed));
  } catch {
    // Not URI-encoded.
  }

  try {
    const base64 = trimmed.replace(/^data:[^,]+,/, '');
    candidates.push(decodeBase64Utf8(base64));
  } catch {
    // Not base64-encoded.
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }

  return null;
}

export function decodeBase64Utf8(value) {
  const binary = window.atob(value);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function readUint32(bytes, offset) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}
