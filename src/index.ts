/**
 * @file Public entry point.
 *
 * A small, dependency-free, namespace-aware streaming XML parser.
 * Feed arbitrary network chunks to {@link SaxParser#write}; the parser emits
 * document events as soon as data becomes available and keeps memory bounded
 * regardless of document size.
 */

export {SaxParser, type SaxOptions, type SaxHandlers, type QName, type Attribute} from './parser.js';
export {NamespaceContext, XML_NS_URI, XMLNS_NS_URI} from './nscontext.js';
export {Chunker} from './chunk.js';
export {SaxError} from './errors.js';
