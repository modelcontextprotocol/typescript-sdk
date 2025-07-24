#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const files = [
  'src/client/index.ts',
  'src/server/index.ts',
  'src/server/mcp.ts'
];

console.log('Testing strict types compatibility...');
console.log('======================================\n');

// Backup original files
const backups = {};
files.forEach(file => {
  const fullPath = join(rootDir, file);
  if (existsSync(fullPath)) {
    backups[file] = readFileSync(fullPath, 'utf8');
    
    // Replace imports
    const content = backups[file];
    const newContent = content.replace(/from "\.\.\/types\.js"/g, 'from "../strictTypes.js"');
    writeFileSync(fullPath, newContent);
    console.log(`✓ Replaced imports in ${file}`);
  }
});

console.log('\nRunning TypeScript compilation...\n');

try {
  // Run TypeScript compilation
  execSync('npm run build', { cwd: rootDir, stdio: 'pipe' });
  console.log('✓ No type errors found!');
} catch (error) {
  // Extract and format type errors
  const output = error.stdout?.toString() || error.stderr?.toString() || '';
  const lines = output.split('\n');
  
  const errors = [];
  let currentError = null;
  
  lines.forEach((line, i) => {
    if (line.includes('error TS')) {
      if (currentError) {
        errors.push(currentError);
      }
      currentError = {
        file: line.split('(')[0],
        location: line.match(/\((\d+),(\d+)\)/)?.[0] || '',
        code: line.match(/error (TS\d+)/)?.[1] || '',
        message: line.split(/error TS\d+:/)[1]?.trim() || '',
        context: []
      };
    } else if (currentError && line.trim() && !line.startsWith('npm ')) {
      currentError.context.push(line);
    }
  });
  
  if (currentError) {
    errors.push(currentError);
  }
  
  // Display errors
  console.log(`Found ${errors.length} type error(s):\n`);
  
  errors.forEach((error, index) => {
    console.log(`${index + 1}. ${error.file}${error.location}`);
    console.log(`   Error ${error.code}: ${error.message}`);
    if (error.context.length > 0) {
      console.log(`   Context:`);
      error.context.slice(0, 3).forEach(line => {
        console.log(`     ${line.trim()}`);
      });
    }
    console.log('');
  });
}

// Restore original files
console.log('Restoring original files...');
Object.entries(backups).forEach(([file, content]) => {
  const fullPath = join(rootDir, file);
  writeFileSync(fullPath, content);
});

console.log('✓ Original files restored.');