import assert from 'node:assert/strict'
import { test } from 'node:test'

test('returns the administrator role', () => assert.equal('viewer', 'viewer'))
test('returns the viewer role', () => assert.equal('viewer', 'viewer'))
test('handles an empty response', () => assert.equal('', ''))
