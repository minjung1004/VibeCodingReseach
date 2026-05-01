const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');

// Initialize the DynamoDB Client (SDK v3 is built into the Node.js 20 Lambda runtime)
const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);

// The table name is passed in automatically by the SAM template environment variables
const tableName = process.env.TABLE_NAME;

exports.handler = async (event, context) => {
    let body;
    let statusCode = 200;
    const headers = {
        "Content-Type": "application/json",
    };

    try {
        const routeKey = `${event.httpMethod} ${event.resource}`;

        switch (routeKey) {
            case "POST /notes":
                const requestJSON = JSON.parse(event.body);
                const newNoteId = crypto.randomUUID();
                
                await dynamo.send(new PutCommand({
                    TableName: tableName,
                    Item: {
                        NoteId: newNoteId,
                        Content: requestJSON.content,
                        CreatedAt: new Date().toISOString()
                    }
                }));
                body = { message: "Note created", id: newNoteId };
                statusCode = 201;
                break;

            case "GET /notes":
                const scanResult = await dynamo.send(new ScanCommand({
                    TableName: tableName
                }));
                body = scanResult.Items;
                break;

            case "GET /notes/{id}":
                const getResult = await dynamo.send(new GetCommand({
                    TableName: tableName,
                    Key: {
                        NoteId: event.pathParameters.id
                    }
                }));
                if (!getResult.Item) {
                    statusCode = 404;
                    body = { error: "Note not found" };
                } else {
                    body = getResult.Item;
                }
                break;

            case "PUT /notes/{id}":
                const updateJSON = JSON.parse(event.body);
                await dynamo.send(new UpdateCommand({
                    TableName: tableName,
                    Key: {
                        NoteId: event.pathParameters.id
                    },
                    UpdateExpression: "set Content = :c, UpdatedAt = :u",
                    ExpressionAttributeValues: {
                        ":c": updateJSON.content,
                        ":u": new Date().toISOString()
                    }
                }));
                body = { message: "Note updated" };
                break;

            case "DELETE /notes/{id}":
                await dynamo.send(new DeleteCommand({
                    TableName: tableName,
                    Key: {
                        NoteId: event.pathParameters.id
                    }
                }));
                body = { message: "Note deleted" };
                break;

            default:
                throw new Error(`Unsupported route: "${routeKey}"`);
        }
    } catch (err) {
        console.error("Error processing request:", err);
        statusCode = 500;
        body = { error: err.message };
    } finally {
        body = JSON.stringify(body);
    }

    return {
        statusCode,
        body,
        headers,
    };
};