import type { SourceFile } from 'ts-morph';
import { Node } from 'ts-morph';

export function renameAllReferences(sourceFile: SourceFile, oldName: string, newName: string): void {
    sourceFile.forEachDescendant(node => {
        if (Node.isIdentifier(node) && node.getText() === oldName) {
            const parent = node.getParent();
            if (!parent) return;
            if (Node.isImportSpecifier(parent)) return;
            if (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) return;
            if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return;
            if (Node.isPropertySignature(parent) && parent.getNameNode() === node) return;
            if (Node.isMethodDeclaration(parent) && parent.getNameNode() === node) return;
            if (Node.isPropertyDeclaration(parent) && parent.getNameNode() === node) return;
            node.replaceWithText(newName);
        }
    });
}
