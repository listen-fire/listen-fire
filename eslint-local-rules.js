const { builtinModules } = require("module");

module.exports = {
  'bottom-exports': {
    meta: {
      type: "suggestion",
      docs: {
        description: "Enforce the use of bottom exports",
        recommended: true,
      },
      schema: [],
    },
    create: function(context) {
      return {
        Program({ body }) {
          const last = body[body.length - 1];
          const allExports = body
            .filter(node => ["ExportNamedDeclaration", "ExportDefaultDeclaration", "ExportAllDeclaration"].includes(node.type))
            // filter out exports of classes - these can be exported inline to aid code analysis
            .filter(node => node.declaration?.type !== "ClassDeclaration");

          if (allExports.length === 0) {
            return;
          }

          if (allExports.length > 1) {
            for (const node of allExports) {
              context.report({
                node,
                message: "Expected only one export",
              });
            }
          }

          // only "export { thing1, thing2 };" is allowed
          if (last.type !== "ExportNamedDeclaration" || !last.specifiers || last.exportKind !== 'value' || last.declaration) {
            context.report({
              node: last,
              message: "An export statement in the form `export { thing1, thing2 };` is expected at the end of the file",
            });
          }
        }
      };
    }
  },
  'require-node-prefix': {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow imports of built-in Node.js modules without the `node:` prefix",
        category: "Best Practices",
        recommended: true,
      },
      fixable: "code",
      schema: [],
    },
    create: context => ({
      ImportDeclaration(node) {
        const { source } = node;
  
        if (source?.type === "Literal" && typeof source.value === "string") {
          const moduleName = source.value;
  
          if (builtinModules.includes(moduleName) && !moduleName.startsWith("node:")) {
            context.report({
              node: source,
              message: `Import of built-in Node.js module "${moduleName}" must use the "node:" prefix.`,
              fix: fixer => fixer.replaceText(source, `"node:${moduleName}"`),
            });
          }
        }
      },
    }),
  },
  'tree-shake-lodash': {
    meta: {
      type: "problem",
      docs: {
        description:
          'Disallow imports of lodash functions from "lodash", instead import from "lodash/..."',
        category: "Best Practices",
        recommended: true,
      },
    },
    create: context => ({
      ImportDeclaration(node) {
        const { source } = node;
  
        if (source?.type === "Literal" && typeof source.value === "string") {
          const moduleName = source.value;
  
          if (moduleName === "lodash") {
            context.report({
              node: source,
              message: `Import of lodash functions from "lodash" is not allowed, instead import from "lodash/..."`,
            });
          }
        }
      },
    }),
  }
};