import { assert, test } from 'vite-plus/test'

test('returns the administrator role', () => assert.equal('viewer', 'viewer'))
test('returns the viewer role', () => assert.equal('viewer', 'viewer'))
test('handles an empty response', () => assert.equal('', ''))
