/**
 * Example demonstrating impact analysis with the TypeScript LSP MCP
 */

// To analyze the impact of changes to the User interface:
// mcp-typescript-lsp action=impact-analysis target=User filePath=/path/to/types.ts depth=2 includeTests=false

// Example output (as s-expression):
/*
(impact-analysis User
  (file /path/to/components/UserProfile.tsx
    (module UserProfile :line 1)
    (class UserProfileComponent :line 5)
    (method render :line 10)
    (function validateUserData :line 25))
  (file /path/to/services/UserService.ts
    (module UserService :line 1)
    (class UserService :line 8)
    (method updateUser :line 15)
    (method deleteUser :line 22))
  (file /path/to/utils/userHelpers.ts
    (function formatUserName :line 3)
    (function getUserDisplayName :line 8)))
*/

// The impact analysis:
// 1. Finds all references to the target symbol (User interface)
// 2. Identifies the containing functions/classes/methods
// 3. Groups results by file
// 4. Can exclude test files with includeTests=false
// 5. Supports recursive analysis up to specified depth

// Use cases:
// - Before refactoring interfaces/types to understand impact
// - API changes to see which components/services are affected
// - Understanding dependencies in large codebases
// - Planning migration strategies

// Different grouping options:
// - groupBy="file" (default): Groups impacts by file
// - groupBy="component": Groups by React components
// - groupBy="flat": Flat list of all impacts
// - groupBy="nested": Shows dependency chains

// Example nested output showing how changes propagate:
/*
(impact-analysis User
  (impacted UserService :kind class :file "UserService.ts" :line 5
    (impacted UserController :kind class :file "UserController.ts" :line 10
      (impacted UserRouter :kind function :file "routes.ts" :line 15)))
  (impacted formatUser :kind function :file "utils.ts" :line 3
    (impacted UserComponent :kind class :file "UserComponent.tsx" :line 8)))
*/

// The nested format clearly shows:
// - User interface is used by UserService
// - UserService is used by UserController  
// - UserController is used by UserRouter
// This makes it easy to understand the full impact chain!