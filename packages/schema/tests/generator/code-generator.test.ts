import { loadModel } from '../utils';
import ZModelCodeGenerator from '../../src/plugins/prisma/zmodel-code-generator';
import { DataModel, DataModelAttribute, DataModelFieldAttribute } from '@zenstackhq/language/ast';

describe('Code Generator Tests', () => {
    const generator = new ZModelCodeGenerator();

    function checkAttribute(ast: DataModelAttribute | DataModelFieldAttribute, expected: string) {
        const result = generator.generateAttribute(ast);
        expect(result).toBe(expected);
    }

    async function getModule(schema: string) {
        if (!schema.includes('datasource ')) {
            schema =
                `
        datasource db {
            provider = 'postgresql'
            url = 'dummy'
        }
        ` + schema;
        }

        return loadModel(schema);
    }

    async function getModelDeclaration(schema: string, name: string) {
        const module = await getModule(schema);
        return module.declarations.find((d) => d.name === name) as DataModel;
    }

    it('check field attribute', async () => {
        const model = await getModelDeclaration(
            `
        model Test{
            id String @id @length(4, 50) @regex('^[0-9a-zA-Z]{4,16}$')
        }
    `,
            'Test'
        );

        checkAttribute(model.fields[0].attributes[0], '@id');
        checkAttribute(model.fields[0].attributes[1], '@length(4, 50)');
        checkAttribute(model.fields[0].attributes[2], "@regex('^[0-9a-zA-Z]{4,16}$')");
    });

    it('check basic model attribute', async () => {
        const model = await getModelDeclaration(
            `
        model User {
            id String @id

            @@deny('all', auth() == null)
            @@allow('create', true)
        }
    `,
            'User'
        );

        checkAttribute(model.attributes[0], `@@deny('all', auth() == null)`);
        checkAttribute(model.attributes[1], `@@allow('create', true)`);
    });

    it('check collection expression', async () => {
        const model = await getModelDeclaration(
            `
            enum UserRole {
                USER
                ADMIN
            }

            model User {
                id String @id
                name String
                role UserRole
                deleted Boolean
                level Int

                
                posts Post[]

                @@allow('read', posts ? [author == auth()])

                @@deny('read', name == '123' && (role == USER || name == '456'))

                @@allow('delete', posts?[author == auth() && ( level <10  || author.role == USER) && !author.deleted])
            }
            
            model Post {
                id String @id
                author User? @relation(fields: [authorId], references: [id])
                authorId String?
            }
    `,
            'User'
        );

        checkAttribute(model.attributes[0], `@@allow('read', posts ? [author == auth()])`);
        checkAttribute(model.attributes[1], `@@deny('read', name == '123' && (role == USER || name == '456'))`);
        checkAttribute(
            model.attributes[2],
            `@@allow('delete', posts ? [author == auth() && (level < 10 || author.role == USER) && !author.deleted])`
        );
    });
});
