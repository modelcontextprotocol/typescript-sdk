// @ts-check

/**
 * Custom ESLint rule to enforce camelCase file naming convention.
 * @type {import('eslint').Rule.RuleModule}
 */
export const fileNamingRule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce camelCase file naming convention',
      recommended: true,
    },
    messages: {
      invalidFileName:
        "File name '{{fileName}}' should be camelCase. Suggested: '{{suggested}}'",
    },
    schema: [
      {
        type: 'object',
        properties: {
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Regex patterns for file names to ignore',
          },
        },
        additionalProperties: false,
      },
    ],
  },

  create(context) {
    return {
      Program(node) {
        const filename = context.filename || context.getFilename();
        const options = context.options[0] || {};
        const ignorePatterns = (options.ignore || []).map(
          (/** @type {string} */ pattern) => new RegExp(pattern)
        );

        // Extract just the file name from the full path
        const parts = filename.split('/');
        const fileName = parts[parts.length - 1];

        // Skip non-TypeScript files
        if (!fileName.endsWith('.ts') && !fileName.endsWith('.tsx')) {
          return;
        }

        // Check if file matches any ignore pattern
        for (const pattern of ignorePatterns) {
          if (pattern.test(fileName)) {
            return;
          }
        }

        // Get the base name (without extension)
        // Handle test files: name.test.ts -> name
        const baseName = fileName
          .replace(/\.test\.ts$/, '')
          .replace(/\.spec\.ts$/, '')
          .replace(/\.test\.tsx$/, '')
          .replace(/\.spec\.tsx$/, '')
          .replace(/\.ts$/, '')
          .replace(/\.tsx$/, '');

        // Get the extension for suggestion
        const extension = fileName.slice(baseName.length);

        // Check if the base name follows camelCase
        // camelCase: starts with lowercase letter, then letters/numbers only
        const camelCaseRegex = /^[a-z][a-zA-Z0-9]*$/;

        if (!camelCaseRegex.test(baseName)) {
          const suggested = toCamelCase(baseName) + extension;

          context.report({
            node,
            messageId: 'invalidFileName',
            data: {
              fileName,
              suggested,
            },
          });
        }
      },
    };
  },
};

/**
 * Convert a string to camelCase
 * @param {string} str
 * @returns {string}
 */
function toCamelCase(str) {
  return str
    .split(/[-_.\s]+/)
    .map((word, index) => {
      if (index === 0) {
        return word.toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}
