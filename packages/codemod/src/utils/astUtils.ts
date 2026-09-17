import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

export function isKeyPositionIdentifier(node: import('ts-morph').Node): boolean {
    const parent = node.getParent();
    if (!parent) return false;
    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) return true;
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return true;
    if (Node.isPropertySignature(parent) && parent.getNameNode() === node) return true;
    if (Node.isMethodDeclaration(parent) && parent.getNameNode() === node) return true;
    if (Node.isMethodSignature(parent) && parent.getNameNode() === node) return true;
    if (Node.isPropertyDeclaration(parent) && parent.getNameNode() === node) return true;
    if (Node.isEnumMember(parent) && parent.getNameNode() === node) return true;
    if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === node) return true;
    if (Node.isGetAccessorDeclaration(parent) && parent.getNameNode() === node) return true;
    if (Node.isSetAccessorDeclaration(parent) && parent.getNameNode() === node) return true;
    return false;
}

export function renameAllReferences(sourceFile: SourceFile, oldName: string, newName: string): void {
    sourceFile.forEachDescendant(node => {
        if (Node.isIdentifier(node) && node.getText() === oldName) {
            const parent = node.getParent();
            if (!parent) return;
            if (Node.isImportSpecifier(parent)) return;
            if (Node.isExportSpecifier(parent)) {
                if (parent.getAliasNode() === node) return;
                if (!parent.getAliasNode()) parent.setAlias(oldName);
                parent.getNameNode().replaceWithText(newName);
                return;
            }
            if (isKeyPositionIdentifier(node)) return;
            if (Node.isShorthandPropertyAssignment(parent)) {
                parent.replaceWithText(`${oldName}: ${newName}`);
                return;
            }
            node.replaceWithText(newName);
        }
    });
}

/** First identifier named `name` that is not part of an import declaration. */
export function findFirstIdentifierOutsideImports(sourceFile: SourceFile, name: string): Node | undefined {
    for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (id.getText() !== name) continue;
        if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue;
        return id;
    }
    return undefined;
}
