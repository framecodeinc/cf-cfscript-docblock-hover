# ColdFusion CFScript DocBlock Hover

Shows the documentation written by developers in `/** ... */` comments when you hover over a CFScript function, like VS Code does for JavaScript.

Works in `.cfc` components and in `<cfscript>` blocks inside `.cfm` files, and also resolves methods defined in other `.cfc` files of the workspace.

```cfml
/**
 * Gets a user.
 * @param id The user id
 * @returns A struct with the user data
 */
public struct function getUser(required numeric id) { ... }
```

Supports `@param name description` and the ColdFusion style `@name description`.

## Development

```
npm install
npm run compile
```

Press F5 to launch the Extension Development Host.
