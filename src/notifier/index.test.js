const fc = require('fast-check');
process.env.GCP_PROJECT = 'test-project'; // Mock project ID for Vertex AI init
const { sanitizeParentFolderId } = require('./index');

describe('Notifier - Drive Upload Bug Fix', () => {
    describe('sanitizeParentFolderId', () => {
        // Unit tests for specific edge cases
        describe('Unit Tests', () => {
            test('should remove single trailing underscore', () => {
                expect(sanitizeParentFolderId('folder123_')).toBe('folder123');
            });

            test('should remove multiple trailing underscores', () => {
                expect(sanitizeParentFolderId('folder123___')).toBe('folder123');
            });

            test('should not modify folder ID without trailing underscores', () => {
                expect(sanitizeParentFolderId('folder123')).toBe('folder123');
            });

            test('should preserve underscores in the middle', () => {
                expect(sanitizeParentFolderId('folder_123_')).toBe('folder_123');
            });

            test('should handle empty string', () => {
                expect(sanitizeParentFolderId('')).toBe('');
            });

            test('should handle string with only underscores', () => {
                expect(sanitizeParentFolderId('___')).toBe('');
            });

            test('should preserve leading underscores', () => {
                expect(sanitizeParentFolderId('_folder123_')).toBe('_folder123');
            });
        });

        // Property-based test
        describe('Property Tests', () => {
            // Feature: transcript-ai-enhancement, Property 1: Trailing Underscore Sanitization
            // **Validates: Requirements 1.1**
            test('Property 1: sanitizeParentFolderId removes all trailing underscores', () => {
                fc.assert(
                    fc.property(
                        fc.string(),
                        fc.array(fc.constant('_'), { minLength: 0, maxLength: 10 }),
                        (baseString, underscores) => {
                            const folderId = baseString + underscores.join('');
                            const sanitized = sanitizeParentFolderId(folderId);

                            // Should not end with underscore
                            expect(sanitized).not.toMatch(/_$/);

                            // If base string doesn't end with underscore, it should be preserved
                            if (baseString.length > 0 && !baseString.endsWith('_')) {
                                expect(sanitized.endsWith(baseString[baseString.length - 1])).toBe(true);
                            }

                            // Sanitized should be a prefix of original (or equal)
                            expect(folderId.startsWith(sanitized)).toBe(true);
                        }
                    ),
                    { numRuns: 100 }
                );
            });
        });
    });
});
