"""FastAPI middleware for request correlation and RFC 9457 problem details."""

import http
import uuid
from typing import Any

import structlog
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

logger = structlog.get_logger("forecast.api")

PROBLEM_CONTENT_TYPE = "application/problem+json"


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """Binds X-Correlation-Id to request state and structlog context, echoing on response."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        correlation_id = request.headers.get("x-correlation-id") or str(uuid.uuid4())
        request.state.correlation_id = correlation_id
        structlog.contextvars.bind_contextvars(correlation_id=correlation_id)

        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.unbind_contextvars("correlation_id")

        response.headers["x-correlation-id"] = correlation_id
        return response


def create_problem_response(
    status: int,
    title: str,
    detail: str,
    instance: str,
    correlation_id: str,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    """Construct RFC 9457 Problem Details JSON response."""
    payload: dict[str, Any] = {
        "type": f"https://kirana.exchange/errors/{status}",
        "title": title,
        "status": status,
        "detail": detail,
        "instance": instance,
        "correlationId": correlation_id,
    }
    if extra:
        payload.update(extra)

    return JSONResponse(
        status_code=status,
        content=payload,
        media_type=PROBLEM_CONTENT_TYPE,
        headers={"x-correlation-id": correlation_id},
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    correlation_id = getattr(request.state, "correlation_id", str(uuid.uuid4()))
    try:
        title = http.HTTPStatus(exc.status_code).phrase
    except ValueError:
        title = "HTTP Error"

    return create_problem_response(
        status=exc.status_code,
        title=title,
        detail=str(exc.detail),
        instance=request.url.path,
        correlation_id=correlation_id,
        extra=getattr(exc, "extra", None),
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    correlation_id = getattr(request.state, "correlation_id", str(uuid.uuid4()))
    return create_problem_response(
        status=422,
        title="Unprocessable Entity",
        detail="Request payload validation failed",
        instance=request.url.path,
        correlation_id=correlation_id,
        extra={"errors": exc.errors()},
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    correlation_id = getattr(request.state, "correlation_id", str(uuid.uuid4()))
    logger.error("Unhandled server exception", exc_info=exc, correlation_id=correlation_id)
    return create_problem_response(
        status=500,
        title="Internal Server Error",
        detail="An unexpected internal error occurred",
        instance=request.url.path,
        correlation_id=correlation_id,
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Register RFC 9457 handlers on FastAPI application."""
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
