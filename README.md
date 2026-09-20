# XML stream core

TypeScript library for namespace-aware streaming parsing.

- `NamespaceStack` — one scope frame per start element; `start(declarations)` pushes,
  `end()` pops and restores the parent scope exactly. Elements with an empty prefix use
  the current default namespace (`xmlns=""` clears it); empty-prefix attributes are
  always in no namespace. The `xml`/`xmlns` prefixes follow the reserved-binding rules.
- `XmlStreamParser` — chunked tokenizer (`write(chunk)` / `end()`) emitting
  `{type: 'start' | 'end', name: {prefix, local, uri}, attributes}` events. Any error
  resets the parser, so unclosed frames never leak into the next document.

Run `npm install`, then `npm test` and `npm run build`.
