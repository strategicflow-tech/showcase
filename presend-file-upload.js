(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StrategicFlowEmailUpload = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const MAX_FILE_SIZE = 2 * 1024 * 1024;
  const SUPPORTED_EXTENSIONS = new Set(['html', 'htm', 'txt', 'eml']);

  function fileExtension(fileName) {
    const match = String(fileName || '').trim().match(/\.([^.\/\\]+)$/);
    return match ? match[1].toLowerCase() : '';
  }

  function decodeBytes(bytes, charset) {
    const labels = [charset || 'utf-8', 'utf-8', 'windows-1252'];
    for (const label of labels) {
      try {
        return new TextDecoder(label).decode(bytes);
      } catch (_error) {
        // Try a widely supported fallback when a message declares an unknown charset.
      }
    }
    return Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  }

  function decodeQuotedPrintable(value, charset) {
    const input = String(value || '').replace(/=\r?\n/g, '');
    const bytes = [];
    const encoder = new TextEncoder();
    for (let index = 0; index < input.length;) {
      if (input[index] === '=' && /^[\da-f]{2}$/i.test(input.slice(index + 1, index + 3))) {
        bytes.push(parseInt(input.slice(index + 1, index + 3), 16));
        index += 3;
        continue;
      }
      const point = input.codePointAt(index);
      const character = String.fromCodePoint(point);
      bytes.push(...encoder.encode(character));
      index += character.length;
    }
    return decodeBytes(Uint8Array.from(bytes), charset);
  }

  function decodeBase64(value, charset) {
    const compact = String(value || '').replace(/\s/g, '');
    const padded = compact + '='.repeat((4 - compact.length % 4) % 4);
    let bytes;
    if (typeof atob === 'function') {
      const binary = atob(padded);
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    } else if (typeof Buffer !== 'undefined') {
      bytes = Uint8Array.from(Buffer.from(padded, 'base64'));
    } else {
      throw new Error('This browser cannot decode the email file.');
    }
    return decodeBytes(bytes, charset);
  }

  function decodeHeaderWord(charset, encoding, content) {
    try {
      if (encoding.toLowerCase() === 'b') return decodeBase64(content, charset);
      return decodeQuotedPrintable(content.replace(/_/g, ' '), charset);
    } catch (_error) {
      return content;
    }
  }

  function decodeHeaderWords(value) {
    return String(value || '')
      .replace(/\?=\s+=\?/g, '?==?')
      .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset, encoding, content) => {
        return decodeHeaderWord(charset, encoding, content);
      });
  }

  function splitHeadersAndBody(raw) {
    const normalized = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const separator = normalized.indexOf('\n\n');
    const headerText = separator < 0 ? '' : normalized.slice(0, separator);
    const body = separator < 0 ? normalized : normalized.slice(separator + 2);
    const unfolded = [];
    for (const line of headerText.split('\n')) {
      if (/^[ \t]/.test(line) && unfolded.length) {
        unfolded[unfolded.length - 1] += ` ${line.trim()}`;
      } else {
        unfolded.push(line);
      }
    }
    const headers = Object.create(null);
    for (const line of unfolded) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }
    return { headers, body };
  }

  function parameterValue(value, name) {
    const expression = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;]+))`, 'i');
    const match = String(value || '').match(expression);
    return match ? String(match[1] || match[2] || match[3] || '').trim() : '';
  }

  function transferDecodedBody(body, encoding, charset) {
    const method = String(encoding || '').trim().toLowerCase();
    if (method === 'base64') return decodeBase64(body, charset);
    if (method === 'quoted-printable') return decodeQuotedPrintable(body, charset);
    return String(body || '');
  }

  function splitMultipartBody(body, boundary) {
    if (!boundary) return [];
    const parts = [];
    const lines = String(body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const opening = `--${boundary}`;
    let collecting = false;
    let current = [];
    for (const line of lines) {
      const marker = line.trim();
      if (marker === opening || marker === `${opening}--`) {
        if (collecting && current.length) parts.push(current.join('\n'));
        if (marker === `${opening}--`) break;
        collecting = true;
        current = [];
      } else if (collecting) {
        current.push(line);
      }
    }
    if (collecting && current.length) parts.push(current.join('\n'));
    return parts;
  }

  function parseMimeEntity(raw, depth) {
    if (depth > 20) return [];
    const parsed = splitHeadersAndBody(raw);
    const headers = parsed.headers;
    const contentType = headers['content-type'] || 'text/plain';
    const mimeType = contentType.split(';')[0].trim().toLowerCase();
    const disposition = String(headers['content-disposition'] || '').split(';')[0].trim().toLowerCase();
    if (disposition === 'attachment') return [];

    if (mimeType.startsWith('multipart/')) {
      const boundary = parameterValue(contentType, 'boundary');
      return splitMultipartBody(parsed.body, boundary).flatMap(part => parseMimeEntity(part, depth + 1));
    }

    const charset = parameterValue(contentType, 'charset') || 'utf-8';
    if (mimeType === 'message/rfc822') {
      const nested = transferDecodedBody(parsed.body, headers['content-transfer-encoding'], charset);
      return parseMimeEntity(nested, depth + 1);
    }
    if (mimeType !== 'text/plain' && mimeType !== 'text/html') return [];
    return [{
      mimeType,
      body: transferDecodedBody(parsed.body, headers['content-transfer-encoding'], charset),
    }];
  }

  function parseEmailFile(fileName, contents) {
    const extension = fileExtension(fileName);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error('Unsupported file type. Choose an .html, .htm, .txt, or .eml file.');
    }
    const source = String(contents || '');
    if (extension !== 'eml') {
      return {
        subject: '',
        body: source,
        hasTextAlternative: false,
        format: extension,
      };
    }

    const rootEntity = splitHeadersAndBody(source);
    const parts = parseMimeEntity(source, 0);
    const htmlPart = parts.find(part => part.mimeType === 'text/html');
    const textPart = parts.find(part => part.mimeType === 'text/plain');
    const selectedPart = htmlPart || textPart;
    if (!selectedPart || !selectedPart.body.trim()) {
      throw new Error('No readable text/plain or text/html body was found in this EML file.');
    }
    return {
      subject: decodeHeaderWords(rootEntity.headers.subject || ''),
      body: selectedPart.body,
      hasTextAlternative: Boolean(htmlPart && textPart),
      format: 'eml',
    };
  }

  function readFileLocally(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('Choose an email file to upload.'));
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        reject(new Error('That file is larger than 2 MB. Choose a smaller file.'));
        return;
      }
      if (!SUPPORTED_EXTENSIONS.has(fileExtension(file.name))) {
        reject(new Error('Unsupported file type. Choose an .html, .htm, .txt, or .eml file.'));
        return;
      }
      if (!root || typeof root.FileReader !== 'function') {
        reject(new Error('This browser cannot read the selected file.'));
        return;
      }
      const reader = new root.FileReader();
      reader.onerror = () => reject(new Error('The browser could not read the file. Try a different file.'));
      reader.onload = () => {
        try {
          resolve(parseEmailFile(file.name, reader.result));
        } catch (error) {
          reject(error);
        }
      };
      reader.readAsText(file);
    });
  }

  return {
    MAX_FILE_SIZE,
    parseEmailFile,
    readFileLocally,
  };
});
