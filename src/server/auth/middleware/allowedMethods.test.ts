import { allowedMethods } from './allowedMethods.js';
import express, { Request, Response } from 'express';
import request from 'supertest';

describe('allowedMethods', () => {
    let app: express.Express;

    beforeEach(() => {
        app = express();

        // Set up a test router with a GET handler and 405 middleware
        const router = express.Router();

        router.get('/test', (req, res) => {
            res.status(200).send('GET success');
        });

        // Add method not allowed middleware for all other methods
        router.all('/test', allowedMethods(['GET']));

        app.use(router);
    });

    test('allows specified HTTP method', async () => {
        const response = await request(app).get('/test');
        expect(response.status).toBe(200);
        expect(response.text).toBe('GET success');
    });

    test('returns 405 for unspecified HTTP methods', async () => {
        const methods = ['post', 'put', 'delete', 'patch'];

        for (const method of methods) {
            // @ts-expect-error - dynamic method call
            const response = await request(app)[method]('/test');
            expect(response.status).toBe(405);
            expect(response.body).toEqual({
                error: 'method_not_allowed',
                error_description: `The method ${method.toUpperCase()} is not allowed for this endpoint`
            });
        }
    });

    test('includes Allow header with specified methods', async () => {
        const response = await request(app).post('/test');
        expect(response.headers.allow).toBe('GET');
    });

    test('works with multiple allowed methods', async () => {
        const multiMethodApp = express();
        const router = express.Router();

        router.get('/multi', (req: Request, res: Response) => {
            res.status(200).send('GET');
        });
        router.post('/multi', (req: Request, res: Response) => {
            res.status(200).send('POST');
        });
        router.all('/multi', allowedMethods(['GET', 'POST']));

        multiMethodApp.use(router);

        // Allowed methods should work
        const getResponse = await request(multiMethodApp).get('/multi');
        expect(getResponse.status).toBe(200);

        const postResponse = await request(multiMethodApp).post('/multi');
        expect(postResponse.status).toBe(200);

        // Unallowed methods should return 405
        const putResponse = await request(multiMethodApp).put('/multi');
        expect(putResponse.status).toBe(405);
        expect(putResponse.headers.allow).toBe('GET, POST');
    });
});
