import { describe, it, expect } from 'vitest';
import { validateMatterRef, inferMatterRef } from '../src/matter-log.js';

describe('validateMatterRef', () => {
  it('accepts alphanumeric with hyphens, underscores, slashes, spaces', () => {
    expect(validateMatterRef('Smith-2024')).toBe(true);
    expect(validateMatterRef('ABC v DEF')).toBe(true);
    expect(validateMatterRef('negligence_research')).toBe(true);
    expect(validateMatterRef('client/matter/01')).toBe(true);
    expect(validateMatterRef('a')).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(validateMatterRef('')).toBe(false);
  });

  it('rejects strings over 100 chars', () => {
    expect(validateMatterRef('a'.repeat(101))).toBe(false);
    expect(validateMatterRef('a'.repeat(100))).toBe(true);
  });

  it('rejects disallowed characters', () => {
    expect(validateMatterRef('smith@example')).toBe(false);
    expect(validateMatterRef('name!')).toBe(false);
    expect(validateMatterRef('case(1)')).toBe(false);
    expect(validateMatterRef('tab\there')).toBe(false);
    expect(validateMatterRef('line\nbreak')).toBe(false);
  });
});

describe('inferMatterRef', () => {
  it('extracts neutral citation when query leads with one', () => {
    const out = inferMatterRef('Smith v Jones [2023] NSWSC 1');
    expect(out).toContain('[2023] NSWSC 1');
  });

  it('extracts "X v Y" case-name pattern', () => {
    // Trailing lowercase/punctuation terminates the greedy party-name run
    const out = inferMatterRef('Smith v Jones, negligence claim');
    expect(out).toBe('Smith v Jones');
  });

  it('extracts AustLII URL parts as court/year/number', () => {
    const out = inferMatterRef('see https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/HCA/2019/11.html for details');
    expect(out).toBe('HCA 2019/11');
  });

  it('picks up a proper-noun run of two or more capitalised tokens', () => {
    const out = inferMatterRef('advice on Johnson Industries restructure');
    expect(out).toBe('Johnson Industries');
  });

  it('falls back to keyword extraction when no proper nouns or citation found', () => {
    const out = inferMatterRef('what are the limitation periods for personal injury claims');
    // STOP words filtered; first non-stop terms joined
    expect(out).toMatch(/limitation/i);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it('returns "untagged" for input with nothing usable', () => {
    const out = inferMatterRef('a an the');
    expect(out).toBe('untagged');
  });

  it('ignores generic sentence-start capitalised words for proper-noun run', () => {
    // "The" is in GENERIC_CAPS — first capitalised token should be skipped
    const out = inferMatterRef('The quick brown fox');
    // No proper-noun run of length >= 2, falls through to keywords
    expect(out).not.toBe('The quick');
  });
});
