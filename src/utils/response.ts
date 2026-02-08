/**
 * 统一 API 响应格式
 */
export interface ApiResponse<T = any> {
    code: number;
    message: string;
    data: T | null;
}

/**
 * 创建标准化 JSON 响应
 * @param code 业务状态码（同时映射为 HTTP 状态码）
 * @param message 消息描述
 * @param data 响应数据
 */
export function createResponse<T = any>(code: number, message: string, data: T | null = null): Response {
    const body: ApiResponse<T> = { code, message, data };
    const httpStatus = (code >= 200 && code < 600) ? code : 200;

    return new Response(JSON.stringify(body, null, 2), {
        status: httpStatus,
        headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*',
        },
    });
}
