export const createResponse = (code: number, message: string, data: any = null) => {
    return new Response(JSON.stringify({
        code,
        message,
        data
    }, null, 2), {
        status: code === 200 ? 200 : (code >= 400 && code < 600 ? code : 200), // Map code to HTTP status if valid, else 200 (or handle appropriately)
        // Simplification: if code is standard HTTP error, use it, else 200.
        // But for API consistencies often 200 is used with error code in body, OR matching status code.
        // Let's match status code for 200, 400, 500.
        headers: {
            'content-type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*', // Useful for APIs
        },
    });
};
