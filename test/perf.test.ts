import {describe, expect, it} from 'vitest';
import {Buffer} from 'node:buffer';
import {SaxParser} from '../src/index.js';

/**
 * Parse `doc` and return wall-clock milliseconds. Absolute throughput under
 * vitest/CI is too noisy to assert against a fixed MB/s number (compiled
 * steady-state is hundreds of MB/s), so these tests guard the property that
 * actually matters: parsing time scales linearly with input, i.e. there is
 * no accidental O(n^2) behaviour.
 */
function timeParse(doc: Buffer): number {
  const p = new SaxParser({
    textChunkSize: 1 << 16,
    handlers: {
      text: () => {
        /* dropped, as a streaming consumer would */
      },
    },
  });
  const started = Date.now();
  const piece = 64 * 1024;
  for (let off = 0; off < doc.length; off += piece) {
    p.write(doc.subarray(off, off + piece));
  }
  p.close();
  return Math.max(1, Date.now() - started);
}

function mbps(bytes: number, ms: number): number {
  return bytes / 1024 / 1024 / (ms / 1000);
}

function textDoc(units: number): Buffer {
  const body = 'abcdef0123'.repeat(2000); // 20 KB of text per unit
  const parts: string[] = ['<r>'];
  for (let k = 0; k < units; k++) parts.push('<item>', body, '</item>');
  parts.push('</r>');
  return Buffer.from(parts.join(''));
}

describe('scaling (no quadratic blow-up)', () => {
  it('text-dominated parse time grows linearly with size', () => {
    const small = textDoc(100);
    const large = textDoc(400); // ~4x the bytes
    const ratio = large.length / small.length;
    expect(ratio).toBeGreaterThan(3.8);

    // Warm up so JIT does not skew the small measurement.
    timeParse(textDoc(20));

    const msSmall = timeParse(small);
    const msLarge = timeParse(large);

    // eslint-disable-next-line no-console
    console.log(
      `\ntext: ${mbps(small.length, msSmall).toFixed(1)} MB/s -> ${mbps(large.length, msLarge).toFixed(1)} MB/s`,
    );

    // Linear work means large/small time ~= size ratio (~4). A quadratic
    // implementation would take ratio^2 (~16); allow generous slack for noise.
    const timeRatio = msLarge / msSmall;
    expect(timeRatio).toBeLessThan(ratio * 2.2);
  });

  it('element-dense parse time grows linearly with size', () => {
    const record =
      '<rec id="%ID%"><p:name xmlns:p="urn:vendor">Item &amp; %ID%</p:name>' +
      '<desc>Some descriptive text with chars.</desc>' +
      '<vals a="1" b="two" c="3.14"/><flag/></rec>';
    const build = (count: number) => {
      const parts = ['<feed xmlns="urn:vf" xmlns:p="urn:v">'];
      for (let id = 0; id < count; id++) parts.push(record.replace('%ID%', String(id)));
      parts.push('</feed>');
      return Buffer.from(parts.join(''));
    };
    const small = build(8000);
    const large = build(32000);
    const ratio = large.length / small.length;
    const msSmall = timeParse(small);
    const msLarge = timeParse(large);

    // eslint-disable-next-line no-console
    console.log(
      `\nelements: ${mbps(small.length, msSmall).toFixed(1)} MB/s -> ${mbps(large.length, msLarge).toFixed(1)} MB/s`,
    );

    const timeRatio = msLarge / msSmall;
    expect(timeRatio).toBeLessThan(ratio * 2.5);
  });
});
