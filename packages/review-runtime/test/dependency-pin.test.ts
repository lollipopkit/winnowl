import { describe, expect, it } from 'vitest';
import { locatePinLine } from '../src/dependency-pin.js';

const at = (text: string, pkg: string, version?: string) => locatePinLine(text.split('\n'), pkg, version);

describe('locatePinLine', () => {
  it('finds the version line inside a pubspec.lock block', () => {
    const lock = [
      'packages:',
      '  http:',
      '    dependency: "direct main"',
      '    description:',
      '      name: http',
      '      url: "https://pub.dev"',
      '    source: hosted',
      '    version: "0.12.2"',
      '  http_parser:',
      '    dependency: transitive',
      '    version: "0.12.2"',
    ].join('\n');
    expect(at(lock, 'http', '0.12.2')).toBe(7);
    expect(at(lock, 'http_parser', '0.12.2')).toBe(10);
  });

  it('does not borrow the next block’s version', () => {
    const lock = ['packages:', '  http:', '    version: "1.0.0"', '  meta:', '    version: "0.12.2"'].join('\n');
    expect(at(lock, 'http', '0.12.2')).toBe(-1);
  });

  it('handles Cargo.lock / poetry.lock sibling keys', () => {
    const lock = [
      '[[package]]',
      'name = "hyper"',
      'version = "0.14.1"',
      '',
      '[[package]]',
      'name = "hyper-util"',
      'version = "0.14.2"',
    ].join('\n');
    expect(at(lock, 'hyper', '0.14.1')).toBe(2);
    expect(at(lock, 'hyper', '0.14.2')).toBe(-1);
  });

  it('handles package-lock and yarn.lock nested blocks', () => {
    const npm = [
      '  "packages": {',
      '    "node_modules/lodash": {',
      '      "version": "4.17.15",',
      '      "resolved": "x"',
      '    },',
      '    "node_modules/lodash/node_modules/y": {',
      '      "version": "1.0.0"',
      '    }',
    ].join('\n');
    expect(at(npm, 'lodash', '4.17.15')).toBe(2);
    const yarn = ['lodash@^4.17.0:', '  version "4.17.15"', '  resolved "x"', '', 'lodash.merge@^4:', '  version "4.6.2"'].join('\n');
    expect(at(yarn, 'lodash', '4.17.15')).toBe(1);
    expect(at(yarn, 'lodash', '4.6.2')).toBe(-1);
  });

  it('handles composer.lock siblings', () => {
    const lock = [
      '        {',
      '            "name": "guzzlehttp/psr7",',
      '            "version": "2.4.4",',
      '        },',
      '        {',
      '            "name": "guzzlehttp/guzzle",',
      '            "version": "7.4.0",',
    ].join('\n');
    expect(at(lock, 'guzzlehttp/psr7', '2.4.4')).toBe(2);
    expect(at(lock, 'guzzlehttp/psr7', '7.4.0')).toBe(-1);
  });

  it('matches single-line pins with exact tokens', () => {
    expect(at('/lodash@4.17.15:\n/lodash@4.17.150:', 'lodash', '4.17.150')).toBe(1);
    expect(at('    rack (2.2.3)', 'rack', '2.2.3')).toBe(0);
    expect(at('golang.org/x/net v0.7.0 h1:abc=', 'golang.org/x/net', '0.7.0')).toBe(0);
    expect(at('requests==2.31.0-post1\nrequests==2.31.0', 'requests', '2.31.0')).toBe(1);
    expect(at('requests>=2', 'requests')).toBe(0);
    expect(at('nothing here', 'requests', '1.0.0')).toBe(-1);
  });
});
