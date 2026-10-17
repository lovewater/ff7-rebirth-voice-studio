from base.model import HealthResponse


def get_health_response() -> HealthResponse:
    """返回健康检查响应。"""
    return HealthResponse(success=True, message="ok")
