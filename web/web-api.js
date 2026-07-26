'use strict';

(() => {
  const PNG_META_KEYWORD = 'speccard';
  let crcTable;

  function safeName(name) {
    return String(name)
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 80) || 'untitled';
  }

  function chooseFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      let settled = false;
      let focusTimer;

      input.type = 'file';
      input.accept = accept;
      input.hidden = true;
      document.body.appendChild(input);

      const finish = (file) => {
        if (settled) return;
        settled = true;
        clearTimeout(focusTimer);
        window.removeEventListener('focus', onWindowFocus);
        input.remove();
        resolve(file || null);
      };
      const onWindowFocus = () => {
        focusTimer = setTimeout(() => {
          if (!input.files || !input.files.length) finish(null);
        }, 500);
      };

      input.addEventListener('change', () => finish(input.files && input.files[0]));
      input.addEventListener('cancel', () => finish(null));
      window.addEventListener('focus', onWindowFocus, { once: true });
      input.click();
    });
  }

  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('이미지를 읽지 못했어요.'));
      reader.onabort = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function dataUrlToBlob(dataUrl) {
    const comma = String(dataUrl).indexOf(',');
    if (comma < 0) throw new Error('이미지 데이터가 올바르지 않아요.');

    const header = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);
    const mimeMatch = /^data:([^;,]+)/i.exec(header);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const bytes = /;base64/i.test(header)
      ? base64ToBytes(payload)
      : new TextEncoder().encode(decodeURIComponent(payload));

    return new Blob([bytes], { type: mime });
  }

  function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let value = n;
        for (let k = 0; k < 8; k++) {
          value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
        }
        crcTable[n] = value >>> 0;
      }
    }

    let crc = 0xFFFFFFFF;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function pngChunk(type, content) {
    const typeBytes = new TextEncoder().encode(type);
    const crcInput = concatBytes([typeBytes, content]);
    const chunk = new Uint8Array(12 + content.length);
    const view = new DataView(chunk.buffer);

    view.setUint32(0, content.length, false);
    chunk.set(typeBytes, 4);
    chunk.set(content, 8);
    view.setUint32(8 + content.length, crc32(crcInput), false);
    return chunk;
  }

  function findPngChunk(bytes, wantedType) {
    if (bytes.length < 20) return -1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let position = 8;

    while (position + 12 <= bytes.length) {
      const length = view.getUint32(position, false);
      if (position + 12 + length > bytes.length) return -1;
      const type = String.fromCharCode(
        bytes[position + 4],
        bytes[position + 5],
        bytes[position + 6],
        bytes[position + 7]
      );
      if (type === wantedType) return position;
      position += 12 + length;
    }
    return -1;
  }

  async function pngBlobWithMetadata(dataUrl, metadata) {
    const original = dataUrlToBlob(dataUrl);
    if (!metadata) return original;

    try {
      const pngBytes = new Uint8Array(await original.arrayBuffer());
      const iendPosition = findPngChunk(pngBytes, 'IEND');
      if (iendPosition < 0) return original;

      const metadataBytes = new TextEncoder().encode(String(metadata));
      const encodedMetadata = new TextEncoder().encode(bytesToBase64(metadataBytes));
      const keyword = new TextEncoder().encode(PNG_META_KEYWORD);
      const content = concatBytes([keyword, new Uint8Array([0]), encodedMetadata]);
      const textChunk = pngChunk('tEXt', content);
      const output = concatBytes([
        pngBytes.subarray(0, iendPosition),
        textChunk,
        pngBytes.subarray(iendPosition),
      ]);
      return new Blob([output], { type: 'image/png' });
    } catch (_) {
      return original;
    }
  }

  function readPngMetadata(bytes) {
    if (bytes.length < 20) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let position = 8;

    while (position + 12 <= bytes.length) {
      const length = view.getUint32(position, false);
      const contentStart = position + 8;
      const contentEnd = contentStart + length;
      if (contentEnd + 4 > bytes.length) return null;

      const type = String.fromCharCode(
        bytes[position + 4],
        bytes[position + 5],
        bytes[position + 6],
        bytes[position + 7]
      );
      if (type === 'tEXt') {
        const content = bytes.subarray(contentStart, contentEnd);
        const separator = content.indexOf(0);
        if (separator > 0) {
          const keyword = new TextDecoder('latin1').decode(content.subarray(0, separator));
          if (keyword === PNG_META_KEYWORD) {
            const encoded = new TextDecoder('latin1').decode(content.subarray(separator + 1));
            const jsonBytes = base64ToBytes(encoded);
            return new TextDecoder().decode(jsonBytes);
          }
        }
      }

      position += 12 + length;
    }
    return null;
  }

  function downloadBlob(blob, fileName) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    return fileName;
  }

  window.api = Object.freeze({
    async readSpecs() {
      throw new Error(
        '웹 브라우저에서는 Windows 사양을 자동으로 읽을 수 없어요. 직접 입력해 주세요.'
      );
    },

    async pickImage() {
      const file = await chooseFile('.png,.jpg,.jpeg,.webp,.gif,image/*');
      return file ? fileAsDataUrl(file) : null;
    },

    async listDesigns() {
      return window.designDb.list();
    },

    async loadDesign(file) {
      return window.designDb.load(file);
    },

    async saveDesign(payload) {
      return window.designDb.save(payload);
    },

    async deleteDesign(file) {
      await window.designDb.remove(file);
      return true;
    },

    async exportPng({ dataUrl, suggestedName, meta }) {
      const blob = await pngBlobWithMetadata(dataUrl, meta);
      const fileName = `${safeName(suggestedName || 'speccard')}.png`;
      return downloadBlob(blob, fileName);
    },

    async exportWebp({ dataBase64, suggestedName }) {
      const blob = new Blob([base64ToBytes(dataBase64)], { type: 'image/webp' });
      const fileName = `${safeName(suggestedName || 'speccard')}.webp`;
      return downloadBlob(blob, fileName);
    },

    async importPng() {
      const file = await chooseFile('.png,image/png');
      if (!file) return null;

      const metadata = readPngMetadata(new Uint8Array(await file.arrayBuffer()));
      if (!metadata) throw new Error('no-meta');
      return JSON.parse(metadata);
    },
  });
})();
