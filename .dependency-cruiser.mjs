export default {
  forbidden: [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    { name: "no-unresolved", severity: "error", from: {}, to: { couldNotResolve: true } },
    {
      name: "no-dev-dependencies",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev", "npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "no-test-or-cli-imports",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(scripts|tests)/|^bun:" },
    },
  ],
  options: { doNotFollow: { path: "node_modules" }, tsConfig: { fileName: "tsconfig.json" } },
};
