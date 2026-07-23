function createVoicePreRollBuffer(maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive integer");
  }

  const chunks = [];
  let byteLength = 0;

  function append(value) {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
    if (!chunk.byteLength) return byteLength;
    chunks.push(chunk);
    byteLength += chunk.byteLength;
    while (byteLength > maxBytes && chunks.length > 1) {
      byteLength -= chunks.shift().byteLength;
    }
    if (byteLength > maxBytes && chunks.length === 1) {
      const tail = chunks[0].subarray(chunks[0].byteLength - maxBytes);
      chunks[0] = tail;
      byteLength = tail.byteLength;
    }
    return byteLength;
  }

  function drain() {
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    clear();
    return output;
  }

  function clear() {
    chunks.length = 0;
    byteLength = 0;
  }

  return {
    append,
    clear,
    drain,
    get byteLength() {
      return byteLength;
    },
  };
}

export { createVoicePreRollBuffer };
