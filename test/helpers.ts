import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect} from 'vitest';
import {SaxParser, type SaxHandlers} from '../src/index.js';

export type Event =
  | {type: 'startDocument'}
  | {type: 'endDocument'}
  | {
      type: 'startElement';
      prefix: string;
      local: string;
      uri: string;
      attributes: Array<{
        prefix: string;
        local: string;
        uri: string;
        value: string;
      }>;
    }
  | {type: 'endElement'; prefix: string; local: string; uri: string}
  | {type: 'text'; text: string}
  | {type: 'cdata'; text: string}
  | {type: 'comment'; text: string}
  | {type: 'processingInstruction'; target: string; data: string};

export function collectEvents(): {events: Event[]; handlers: SaxHandlers} {
  const events: Event[] = [];
  const handlers: SaxHandlers = {
    startDocument: () => events.push({type: 'startDocument'}),
    endDocument: () => events.push({type: 'endDocument'}),
    startElement: (name, attributes) =>
      events.push({
        type: 'startElement',
        prefix: name.prefix,
        local: name.local,
        uri: name.uri,
        attributes: attributes.map((a) => ({
          prefix: a.name.prefix,
          local: a.name.local,
          uri: a.name.uri,
          value: a.value,
        })),
      }),
    endElement: (name) =>
      events.push({type: 'endElement', prefix: name.prefix, local: name.local, uri: name.uri}),
    text: (text) => events.push({type: 'text', text}),
    cdata: (text) => events.push({type: 'cdata', text}),
    comment: (text) => events.push({type: 'comment', text}),
    processingInstruction: (target, data) =>
      events.push({type: 'processingInstruction', target, data}),
  };
  return {events, handlers};
}

/** Parse `doc` (string or bytes) given to write() as a single piece. */
export function parseWhole(doc: string | Uint8Array): Event[] {
  const {events, handlers} = collectEvents();
  const p = new SaxParser({handlers, textChunkSize: 64});
  p.write(typeof doc === 'string' ? Buffer.from(doc, 'utf8') : doc);
  p.close();
  return events;
}

/**
 * Parse `doc` after chopping its UTF-8 bytes with `sizes` cycled for chunk
 * lengths. `sizes` may include 0 (empty writes).
 */
export function parseChopped(doc: string, sizes: number[]): Event[] {
  const bytes = Buffer.from(doc, 'utf8');
  const {events, handlers} = collectEvents();
  const p = new SaxParser({handlers, textChunkSize: 64});
  let off = 0;
  let si = 0;
  while (off < bytes.length) {
    const size = Math.min(sizes[si % sizes.length], bytes.length - off);
    p.write(bytes.subarray(off, off + size));
    off += size;
    si++;
  }
  p.close();
  return events;
}

/** A varied spread of nasty cut widths, including 1 and prime-ish lengths. */
export const ALL_SIZES: number[][] = [
  [1],
  [2],
  [3],
  [7],
  [64],
  [1000],
  [1, 1, 1, 5],
  [3, 1, 4, 1, 5, 9, 2, 6],
  [13, 7, 2, 11, 3],
  [128, 1, 64, 2],
];

export function assertSameEventsAcrossCuts(doc: string): Event[] {
  const baseline = parseWhole(doc);
  for (const sizes of ALL_SIZES) {
    expect(parseChopped(doc, sizes)).toEqual(baseline);
  }
  return baseline;
}

/**
 * Deterministic pseudo-random cut widths derived from a seed, so a failure
 * can be reproduced. Returns the events from each cut plan.
 */
export function randomCuts(doc: string, seed: number, plans = 6): Event[][] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
  const result: Event[][] = [];
  for (let plan = 0; plan < plans; plan++) {
    const bytes = Buffer.from(doc, 'utf8');
    const {events, handlers} = collectEvents();
    const p = new SaxParser({handlers, textChunkSize: 37 + (next() % 200)});
    let off = 0;
    while (off < bytes.length) {
      const size = Math.min(1 + (next() % 16), bytes.length - off);
      p.write(bytes.subarray(off, off + size));
      off += size;
    }
    p.close();
    result.push(events);
  }
  return result;
}

export function joinText(events: Event[]): string {
  let out = '';
  for (const e of events) {
    if (e.type === 'text' || e.type === 'cdata') out += e.text;
  }
  return out;
}

/** Load a UTF-8 fixture from test/fixtures. */
export function fixture(name: string): string {
  const url = new URL(`fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}
