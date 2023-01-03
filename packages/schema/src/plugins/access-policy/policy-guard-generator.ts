import {
    DataModel,
    Expression,
    Model,
    isBinaryExpr,
    isDataModel,
    isEnum,
    isInvocationExpr,
    isUnaryExpr,
} from '@zenstackhq/language/ast';
import { PolicyKind, PolicyOperationKind } from '@zenstackhq/runtime';
import { GUARD_FIELD_NAME, PluginOptions, getLiteral, resolved } from '@zenstackhq/sdk';
import { camelCase } from 'change-case';
import { streamAllContents } from 'langium';
import path from 'path';
import { FunctionDeclaration, Project, SourceFile, VariableDeclarationKind } from 'ts-morph';
import { name } from '.';
import { analyzePolicies } from '../../utils/ast-utils';
import { ALL_OPERATION_KINDS, RUNTIME_PACKAGE, getDefaultOutputFolder } from '../plugin-utils';
import { ExpressionWriter } from './expression-writer';
import { isFromStdlib } from '../../language-server/utils';

const UNKNOWN_USER_ID = 'zenstack_unknown_user';

/**
 * Generates source file that contains Prisma query guard objects used for injecting database queries
 */
export default class PolicyGuardGenerator {
    async generate(model: Model, options: PluginOptions) {
        const output = options.output ? (options.output as string) : getDefaultOutputFolder();
        if (!output) {
            console.error(`Unable to determine output path, not running plugin ${name}`);
            return;
        }

        const project = new Project();
        const sf = project.createSourceFile(path.join(output, 'policy.ts'), undefined, { overwrite: true });

        sf.addImportDeclaration({
            namedImports: [{ name: 'QueryContext' }],
            moduleSpecifier: `${RUNTIME_PACKAGE}`,
            isTypeOnly: true,
        });

        // import enums
        for (const e of model.declarations.filter((d) => isEnum(d))) {
            sf.addImportDeclaration({
                namedImports: [{ name: e.name }],
                moduleSpecifier: '@prisma/client',
            });
        }

        const models = model.declarations.filter((d) => isDataModel(d)) as DataModel[];

        const policyMap: Record<string, Record<string, string | boolean>> = {};
        for (const model of models) {
            policyMap[model.name] = await this.generateQueryGuardForModel(model, sf);
        }

        sf.addVariableStatement({
            declarationKind: VariableDeclarationKind.Const,
            declarations: [
                {
                    name: 'policy',
                    initializer: (writer) => {
                        writer.block(() => {
                            writer.write('guard:'),
                                writer.block(() => {
                                    for (const [model, map] of Object.entries(policyMap)) {
                                        writer.write(`${camelCase(model)}:`);
                                        writer.block(() => {
                                            for (const [op, func] of Object.entries(map)) {
                                                writer.write(`${op}: ${func},`);
                                            }
                                        });
                                        writer.write(',');
                                    }
                                });
                        });
                    },
                },
            ],
        });

        sf.addStatements('export default policy');

        sf.formatText();
        await project.save();
        await project.emit();
    }

    private getPolicyExpressions(model: DataModel, kind: PolicyKind, operation: PolicyOperationKind) {
        const attrs = model.attributes.filter((attr) => attr.decl.ref?.name === `@@${kind}`);

        const checkOperation = operation === 'postUpdate' ? 'update' : operation;

        let result = attrs
            .filter((attr) => {
                const opsValue = getLiteral<string>(attr.args[0].value);
                if (!opsValue) {
                    return false;
                }
                const ops = opsValue.split(',').map((s) => s.trim());
                return ops.includes(checkOperation) || ops.includes('all');
            })
            .map((attr) => attr.args[1].value);

        if (operation === 'update') {
            result = this.processUpdatePolicies(result, false);
        } else if (operation === 'postUpdate') {
            result = this.processUpdatePolicies(result, true);
        }

        return result;
    }

    private processUpdatePolicies(expressions: Expression[], postUpdate: boolean) {
        return expressions
            .map((expr) => this.visitPolicyExpression(expr, postUpdate))
            .filter((e): e is Expression => !!e);
    }

    private visitPolicyExpression(expr: Expression, postUpdate: boolean): Expression | undefined {
        if (isBinaryExpr(expr) && (expr.operator === '&&' || expr.operator === '||')) {
            const left = this.visitPolicyExpression(expr.left, postUpdate);
            const right = this.visitPolicyExpression(expr.right, postUpdate);
            if (!left) return right;
            if (!right) return left;
            return { ...expr, left, right };
        }

        if (isUnaryExpr(expr) && expr.operator === '!') {
            const operand = this.visitPolicyExpression(expr.operand, postUpdate);
            if (!operand) return undefined;
            return { ...expr, operand };
        }

        if (postUpdate && !this.hasFutureReference(expr)) {
            return undefined;
        } else if (!postUpdate && this.hasFutureReference(expr)) {
            return undefined;
        }

        return expr;
    }

    private hasFutureReference(expr: Expression) {
        for (const node of streamAllContents(expr)) {
            if (isInvocationExpr(node) && node.function.ref?.name === 'future' && isFromStdlib(node.function.ref)) {
                return true;
            }
        }
        return false;
    }

    private async generateQueryGuardForModel(model: DataModel, sourceFile: SourceFile) {
        const result: Record<string, string | boolean> = {};

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const policies: any = analyzePolicies(model);

        for (const kind of ALL_OPERATION_KINDS) {
            if (policies[kind] === true || policies[kind] === false) {
                result[kind] = policies[kind];
                continue;
            }

            const denies = this.getPolicyExpressions(model, 'deny', kind);
            const allows = this.getPolicyExpressions(model, 'allow', kind);

            if (kind === 'update' && allows.length === 0) {
                // no allow rule for 'update', policy is constant based on if there's
                // post-update counterpart
                if (this.getPolicyExpressions(model, 'allow', 'postUpdate').length === 0) {
                    result[kind] = false;
                    continue;
                } else {
                    result[kind] = true;
                    continue;
                }
            }

            if (kind === 'postUpdate' && allows.length === 0 && denies.length === 0) {
                // no rule 'postUpdate', always allow
                result[kind] = true;
                continue;
            }

            const func = this.generateQueryGuardFunction(sourceFile, model, kind, allows, denies);
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            result[kind] = func.getName()!;
        }
        return result;
    }

    private generateQueryGuardFunction(
        sourceFile: SourceFile,
        model: DataModel,
        kind: PolicyOperationKind,
        allows: Expression[],
        denies: Expression[]
    ): FunctionDeclaration {
        const func = sourceFile
            .addFunction({
                name: model.name + '_' + kind,
                returnType: 'any',
                parameters: [
                    {
                        name: 'context',
                        type: 'QueryContext',
                    },
                ],
            })
            .addBody();

        // check if any allow or deny rule contains 'auth()' invocation
        let hasAuthRef = false;
        for (const node of [...denies, ...allows]) {
            for (const child of streamAllContents(node)) {
                if (isInvocationExpr(child) && resolved(child.function).name === 'auth') {
                    hasAuthRef = true;
                    break;
                }
            }
            if (hasAuthRef) {
                break;
            }
        }

        if (hasAuthRef) {
            func.addStatements(
                // make sure user id is always available
                `const user = context.user?.id ? context.user : { ...context.user, id: '${UNKNOWN_USER_ID}' };`
            );
        }

        // r = <guard object>;
        func.addVariableStatement({
            declarationKind: VariableDeclarationKind.Const,
            declarations: [
                {
                    name: 'r',
                    initializer: (writer) => {
                        const exprWriter = new ExpressionWriter(writer, kind === 'postUpdate');
                        const writeDenies = () => {
                            writer.conditionalWrite(denies.length > 1, '{ AND: [');
                            denies.forEach((expr, i) => {
                                writer.block(() => {
                                    writer.write('NOT: ');
                                    exprWriter.write(expr);
                                });
                                writer.conditionalWrite(i !== denies.length - 1, ',');
                            });
                            writer.conditionalWrite(denies.length > 1, ']}');
                        };

                        const writeAllows = () => {
                            writer.conditionalWrite(allows.length > 1, '{ OR: [');
                            allows.forEach((expr, i) => {
                                exprWriter.write(expr);
                                writer.conditionalWrite(i !== allows.length - 1, ',');
                            });
                            writer.conditionalWrite(allows.length > 1, ']}');
                        };

                        if (allows.length > 0 && denies.length > 0) {
                            writer.writeLine('{ AND: [');
                            writeDenies();
                            writer.writeLine(',');
                            writeAllows();
                            writer.writeLine(']}');
                        } else if (denies.length > 0) {
                            writeDenies();
                        } else if (allows.length > 0) {
                            writeAllows();
                        } else {
                            // disallow any operation
                            writer.write(`{ ${GUARD_FIELD_NAME}: false }`);
                        }
                    },
                },
            ],
        });

        func.addStatements('return r;');
        return func;
    }
}