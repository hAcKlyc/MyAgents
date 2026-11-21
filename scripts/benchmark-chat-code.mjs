// Isolate component commit time; full-window interaction is verified in the packaged app.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { webkit } from 'playwright';

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';
    import {refractor} from 'refractor/all';
    window.lexCode = code => refractor.highlight(code,'typescript');
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {ThemeRuntimeProvider} from './src/renderer/theme/ThemeRuntime';
    import CodeBlock from './src/renderer/components/markdown/CodeBlock';
    const containers = [false,true].map(() => document.body.appendChild(document.createElement('div')));
    const roots = containers.map(container => createRoot(container));
    window.codeNode = streaming => containers[Number(streaming)].querySelector('pre');
    const selection = {themeId:'myagents-default',appearanceMode:'light'};
    window.renderCode = (code, streaming, target=streaming, language='typescript', appearanceMode='light') => flushSync(() => roots[Number(target)].render(
      <ThemeRuntimeProvider selection={{...selection,appearanceMode}}><CodeBlock streaming={streaming} language={language}>{code}</CodeBlock></ThemeRuntimeProvider>
    ));
  ` },
  bundle: true, minify: true, write: false, jsx: 'automatic', platform: 'browser', format: 'iife',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}', '__DEBUG_MODE__': 'false', '__APP_VERSION__': '"test"' },
});
const browser = await webkit.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(error.message));
  await page.route('http://localhost:4170/', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto('http://localhost:4170/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(({indented, raw}) => {
    const samples = {};
    const indent = indented ? '  ' : '';
    const base = (indented ? 'function series() {\n' : '') + Array.from({length:1000}, (_, i) =>
      indent + 'const value' + i + ': number = ' + i + ';').join('\n') + '\n' + indent + '// ';
    for (const mode of ['reference','streaming','lexer']) {
      const times = [];
      for (let i=0; i<105; i++) {
        const source = base + 'x'.repeat(i);
        const start = performance.now();
        if (mode === 'lexer') window.lexCode(source);
        else window.renderCode(source, mode === 'streaming');
        if (i>=5) times.push(performance.now()-start);
      }
      times.sort((a,b)=>a-b);
      samples[mode] = {median:times[49], p95:times[94], max:times[99], ...(raw ? {sortedMs:times}: {})};
    }
    const prefix = 'let a = 1;\n'.repeat(8);
    const inputs = [prefix + '/* comment\nsecond line', prefix + '/* comment\nsecond line */ const x=1;',
      prefix + 'const s = `a ${', prefix + 'const s = `a ${2}`;', base + '中文😀', base.replace('value5','changed') + '中文',
      'a\nb\nc\nd\ne', 'a\nb\nc\nd\ne\nf', prefix + 'x'.repeat(10000), prefix.replaceAll('\n','\r\n')];
    const equal = inputs.every(input => {
      window.renderCode(input, false);
      window.renderCode(input, true);
      return window.codeNode(false).outerHTML === window.codeNode(true).outerHTML;
    });
    // Compare every successive prefix of input whose later characters reclassify
    // earlier tokens. The reference and candidate stay mounted across the sequence.
    const changing = ['/* start', 'comment */ const x = "中😀";', 'const template = `str ${x}`;',
      'const regex = /[a-z]+/;', 'function nested() {', '  return template;', '}'].join('\n');
    let compared = 0;
    for (const language of ['typescript', 'ts', 'javascript', 'js']) {
      for (const appearance of ['light','dark']) {
        for (let i=0; i<=changing.length; i++) {
          const value = prefix + changing.slice(0,i);
          window.renderCode(value,false,false,language,appearance);
          window.renderCode(value,true,true,language,appearance);
          if (window.codeNode(false).outerHTML !== window.codeNode(true).outerHTML) {
            throw Error('Token mismatch at prefix '+i+' in '+language+'/'+appearance);
          }
          compared++;
        }
      }
    }
    window.renderCode(base+'x', true);
    const code = window.codeNode(true);
    const selected = code.querySelector('.token').firstChild;
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const expected = selection.toString();
    window.renderCode(base+'x2', true);
    window.renderCode(base+'x2', false, true);
    const retained = selected.isConnected && expected.length > 0 && selection.toString() === expected;
    return {samples,equal,retained,indented,compared};
  }, {indented:process.argv.includes('--indented'),raw:process.argv.includes('--raw')});
  console.log(JSON.stringify(result));
  assert.equal(result.retained,true,'Selection survives append and terminal transition');
  assert.equal(result.equal,true,'Displayed tokens and markup must match the reference');
} finally {
  await browser.close();
}
