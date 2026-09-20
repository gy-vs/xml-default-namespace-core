# XML stream core

TypeScript library for namespace-aware streaming XML parsing.

Run `npm install`, then `npm test` and `npm run build`.

## API

### `XmlStreamParser`

Incremental parser. `write(chunk)` accepts arbitrarily split input and returns
the events completed by that chunk; `end()` finalizes the document and throws
if any element is still open. On any parse error the parser resets itself, so
unclosed namespace frames never leak into the next document.

Events carry prefix, local name and resolved namespace URI:

- `{ type: 'startElement', name: QName, attributes: XmlAttribute[] }`
- `{ type: 'endElement', name: QName }`
- `{ type: 'text', text: string }`

### `NamespaceStack`

One scope frame per element: `start(declarations)` pushes the declarations
found on a start element, `end()` pops exactly that frame. Resolution follows
"Namespaces in XML": elements with an empty prefix use the current default
namespace (`xmlns=""` clears it), attributes with an empty prefix are always
in no namespace, and the reserved `xml`/`xmlns` prefixes cannot be illegally
rebound.
