# xml-default-namespace-core

A tiny, dependency-free, **namespace-aware streaming XML 1.0 parser** for
TypeScript. It is built for a gateway that receives XML over the network in
arbitrarily fragmented TCP segments: feed bytes as they arrive and get
document events as soon as the data is available, with memory that stays
bounded no matter how large the document is.

## Why

Buffering a whole document before parsing makes memory grow with document
size (hundreds of MB per quote, in our case). This parser:

- consumes chunks via `write()` and never holds more than a small suffix
  needed to disambiguate a marker split across packets;
- streams large text/CDATA nodes as fixed-size events instead of buffering
  them until the element closes;
- decodes UTF-8 incrementally — a multi-byte character split mid-sequence is
  reassembled transparently;
- produces the **exact same event sequence for every possible chunking** of
  the same document (event boundaries for text depend only on a configured
  character count, never on packet boundaries).

## Install / build / test

```bash
npm install
npm test       # vitest
npm run build  # tsc -> dist/
```

There is no command-line interface; this is an importable library.

## Usage

```ts
import {SaxParser} from './src/index.js'; // or the package export ./dist/index.js

const parser = new SaxParser({
  textChunkSize: 1 << 16, // optional: target size (chars) of text/cdata events
  handlers: {
    startDocument() {},
    endDocument() {},
    startElement(name, attributes) {
      // name:  { prefix, local, uri }
      // attributes: [{ name: { prefix, local, uri }, value }]
    },
    endElement(name) {},
    text(text) {},        // streamed for large nodes
    cdata(text) {},       // streamed
    comment(text) {},
    processingInstruction(target, data) {},
  },
});

socket.on('data', (chunk: Buffer) => parser.write(chunk)); // Uint8Array or string
socket.on('end', () => parser.close()); // validates document is complete
```

Reuse one instance for many documents on one connection:

```ts
parser.write(doc1); parser.close();
// ...
parser.reset();        // clears ALL state; doc2 is unaffected by doc1
parser.write(doc2); parser.close();
```

After a parse error the parser is unusable until `reset()`.

## Event model

- `startElement` / `endElement` carry `{ prefix, local, uri }`. `uri === ''`
  means "in no namespace".
- Unprefixed **elements** take the default namespace when one is in scope;
  unprefixed **attributes never have a namespace** (`uri === ''`).
- `xmlns` / `xmlns:*` declarations are resolved into the scope and are *not*
  reported as attributes.
- Two attributes that resolve to the same `{uri}local` are reported as a
  duplicate-attribute error even if their prefixes differ.
- The built-in `xml` prefix is always bound; binding `xmlns` as a prefix,
  rebinding `xml` to another URI, or binding another prefix to the xml
  namespace URI are all rejected.
- Default namespaces can be redeclared, cleared with `xmlns=""`, and restore
  automatically when the element scope ends.
- Text may arrive as several adjacent `text` (or `cdata`) events;
  concatenating them yields the decoded source, character for character.
  CDATA content is delivered verbatim (entities are not expanded).

## Line endings and text fidelity

CR and CRLF are both normalized to LF per the XML recommendation, including
when the two halves of a CRLF land in different network packets. The decoded
text concatenation equals the source after normalization/entity expansion.

## Errors

Malformed input throws a `SaxError` carrying 1-based `line`, `column` and a
reason: unclosed tags, mismatched end tags, unbound prefixes, illegal
character references, duplicate attributes, illegal comment content, and so
on. Reported positions are independent of how input was chunked.

Only the five predefined entities (`lt gt amp apos quot`) and numeric
character references are allowed. Any named entity not in that set is
rejected, and a DOCTYPE with an **internal subset** (which could carry entity
declarations) is refused outright. External `DOCTYPE … SYSTEM/PUBLIC`
declarations without an internal subset are accepted but otherwise ignored.

## Memory and throughput

- Markup constructs (tags, comments, PIs, DOCTYPE) are buffered only until
  their end, capped at 16 MB. Text and CDATA are never fully buffered.
- Text/CDATA events are emitted in chunks of roughly `textChunkSize`
  characters and are available immediately, before the enclosing element
  ends.
- The parser's retained heap does not grow with document size.
- Text-dominated documents (the large-quote case) parse at hundreds of MB/s;
  element-dense documents are bounded by the fixed cost per emitted event.

## Layout

```
src/
  index.ts     public entry: SaxParser, SaxError, types
  parser.ts    chunk-driven tokenizer + namespace-aware event producer
  nscontext.ts scoped prefix/URI bindings
  chunk.ts     fixed-size string re-chunker (chunking-independent events)
  position.ts  line/column tracking over normalized input
  errors.ts    SaxError
test/          vitest suites; helpers re-feed the same bytes under many cuts
```
