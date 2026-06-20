#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FORMATS = new Set(['sub2api', 'cpa', 'cockpit', '9router', 'codex', 'axonhub', 'codexmanager']);

function usage() {
  return `Usage: gpt-session-convert [--format cpa] [--extract-json] [--proxy-url URL] [--input FILE]\n\nReads session JSON/text from stdin by default and writes converted JSON to stdout.`;
}

function parseArgs(argv) {
  const opts = { format: 'cpa', extractJSON: false, proxyURL: '', input: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--extract-json') {
      opts.extractJSON = true;
    } else if (arg === '--format') {
      opts.format = argv[++i] || '';
    } else if (arg.startsWith('--format=')) {
      opts.format = arg.slice('--format='.length);
    } else if (arg === '--proxy-url') {
      opts.proxyURL = argv[++i] || '';
    } else if (arg.startsWith('--proxy-url=')) {
      opts.proxyURL = arg.slice('--proxy-url='.length);
    } else if (arg === '--input') {
      opts.input = argv[++i] || '';
    } else if (arg.startsWith('--input=')) {
      opts.input = arg.slice('--input='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  opts.format = String(opts.format || '').toLowerCase();
  if (!FORMATS.has(opts.format)) {
    throw new Error(`Unsupported format: ${opts.format}`);
  }
  return opts;
}

function readInput(file) {
  if (file) return fs.readFileSync(file, 'utf8');
  return fs.readFileSync(0, 'utf8');
}

function extractJSONValues(text) {
  const values = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    for (let end = findJSONEnd(text, i); end > i; end = -1) {
      const snippet = text.slice(i, end);
      try {
        values.push(JSON.parse(snippet));
        i = end - 1;
      } catch {
        // Ignore malformed candidates and keep scanning after the opener.
      }
      break;
    }
  }
  return values;
}

function findJSONEnd(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function createFakeElement(selector, options = {}) {
  const classes = new Set();
  return {
    selector,
    attributes: {},
    dataset: options.dataset || {},
    disabled: false,
    files: [],
    innerHTML: '',
    listeners: {},
    style: {},
    textContent: '',
    value: '',
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) { force ? classes.add(name) : classes.delete(name); },
    },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    append() {},
    click() { this.listeners.click?.({ target: this }); },
    remove() {},
    select() {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
  };
}

function loadPageHarness() {
  const htmlPath = path.join(__dirname, '..', 'docs', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
  if (!match) throw new Error('docs/index.html inline script not found');

  const elements = new Map();
  const formatButtons = Array.from(FORMATS).map((format) =>
    createFakeElement(`[data-format="${format}"]`, { dataset: { format } })
  );
  const document = {
    body: createFakeElement('body'),
    createElement(selector) { return createFakeElement(selector); },
    execCommand() { return true; },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createFakeElement(selector));
      return elements.get(selector);
    },
    querySelectorAll(selector) { return selector === '[data-format]' ? formatButtons : []; },
  };
  const context = {
    TextDecoder,
    TextEncoder,
    URL: { createObjectURL() { return 'blob:gpt-session-convert'; }, revokeObjectURL() {} },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    clearTimeout,
    console: { ...console, log() {} },
    document,
    navigator: { clipboard: { async writeText() {} } },
    setTimeout,
  };
  vm.runInNewContext(match[1], context, { filename: htmlPath });
  return { elements, formatButtons };
}

function dispatch(element, type) {
  if (typeof element.listeners[type] !== 'function') {
    throw new Error(`missing ${type} listener on ${element.selector}`);
  }
  element.listeners[type]({ target: element });
}

function addProxyURL(document, proxyURL) {
  const trimmed = String(proxyURL || '').trim();
  if (!trimmed || document == null) return document;
  const add = (item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) item.proxy_url = trimmed;
    return item;
  };
  if (Array.isArray(document)) return document.map(add);
  return add(document);
}

function convert(text, opts) {
  const { elements, formatButtons } = loadPageHarness();
  const button = formatButtons.find((item) => item.dataset.format === opts.format);
  if (!button) throw new Error(`format button not found: ${opts.format}`);
  dispatch(button, 'click');

  const input = elements.get('#session-input');
  const output = elements.get('#output');
  const issues = elements.get('#issues');
  const status = elements.get('#input-status');
  const sourceText = opts.extractJSON ? JSON.stringify(extractJSONValues(text)) : text;
  input.value = sourceText;
  dispatch(input, 'input');

  if (!String(output.value || '').trim()) {
    const message = String(issues?.textContent || status?.textContent || 'conversion produced no output').trim();
    throw new Error(message || 'conversion produced no output');
  }
  const parsed = JSON.parse(output.value);
  return addProxyURL(parsed, opts.proxyURL);
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const text = readInput(opts.input);
    const converted = convert(text, opts);
    process.stdout.write(`${JSON.stringify(converted, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { convert, extractJSONValues };
