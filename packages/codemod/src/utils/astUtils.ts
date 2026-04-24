import type { SourceFile } from 'ts-morph';
import { Node } from 'ts-morph';

export function renameAllReferences(sourceFile: SourceFile, oldName: string, newName: string): void {
    sourceFile.forEachDescendant(node => {
        if (Node.isIdentifier(node) && node.getText() === oldName) {
            const parent = node.getParent();
            if (!parent) return;
            if (Node.isImportSpecifier(parent)) return;
            if (Node.isExportSpecifier(parent)) {
                if (!parent.getAliasNode()) parent.setAlias(oldName);
                parent.getNameNode().replaceWithText(newName);
                return;
            }
            if (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) return;
            if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return;
            if (Node.isPropertySignature(parent) && parent.getNameNode() === node) return;
            if (Node.isMethodDeclaration(parent) && parent.getNameNode() === node) return;
            if (Node.isMethodSignature(parent) && parent.getNameNode() === node) return;
            if (Node.isPropertyDeclaration(parent) && parent.getNameNode() === node) return;
            if (Node.isEnumMember(parent) && parent.getNameNode() === node) return;
            if (Node.isGetAccessorDeclaration(parent) && parent.getNameNode() === node) return;
            if (Node.isSetAccessorDeclaration(parent) && parent.getNameNode() === node) return;
            if (Node.isShorthandPropertyAssignment(parent)) {
                parent.replaceWithText(`${oldName}: ${newName}`);
                return;
            }
            node.replaceWithText(newName);
        }
    });
}
