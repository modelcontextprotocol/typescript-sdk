#!/bin/bash

# Script to test strict types by replacing imports and running tests

echo "Testing strict types compatibility..."
echo "======================================"

# Save original files
cp src/client/index.ts src/client/index.ts.bak
cp src/server/index.ts src/server/index.ts.bak  
cp src/server/mcp.ts src/server/mcp.ts.bak

# Replace imports
sed -i '' 's/from "\.\.\/types\.js"/from "..\/strictTypes.js"/g' src/client/index.ts
sed -i '' 's/from "\.\.\/types\.js"/from "..\/strictTypes.js"/g' src/server/index.ts
sed -i '' 's/from "\.\.\/types\.js"/from "..\/strictTypes.js"/g' src/server/mcp.ts

echo "Replaced imports in:"
echo "  - src/client/index.ts"
echo "  - src/server/index.ts"
echo "  - src/server/mcp.ts"
echo ""

# Run TypeScript compilation to get type errors
echo "Running TypeScript compilation..."
echo ""
npm run build 2>&1 | grep -E "(error TS|src/)" | grep -B1 "error TS" || true

# Restore original files
mv src/client/index.ts.bak src/client/index.ts
mv src/server/index.ts.bak src/server/index.ts
mv src/server/mcp.ts.bak src/server/mcp.ts

echo ""
echo "Original files restored."