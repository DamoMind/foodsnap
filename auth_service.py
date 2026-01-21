"""
Authentication service for FoodSnap.
Handles JWT token generation/validation and OAuth provider verification.
"""
import os
import secrets
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

import httpx
from jose import jwt, JWTError
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests


class AuthError(Exception):
    """Authentication error."""
    pass


class AuthService:
    """JWT token management and OAuth verification."""

    def __init__(
        self,
        jwt_secret: str,
        jwt_algorithm: str = "HS256",
        access_token_expire_minutes: int = 60 * 24 * 7,  # 7 days
        google_client_id: Optional[str] = None,
        apple_client_id: Optional[str] = None,
    ):
        self.jwt_secret = jwt_secret
        self.jwt_algorithm = jwt_algorithm
        self.access_token_expire_minutes = access_token_expire_minutes
        self.google_client_id = google_client_id
        self.apple_client_id = apple_client_id

    # ==================== JWT Token Management ====================

    def create_access_token(self, user_id: str, extra_claims: Optional[Dict] = None) -> str:
        """Create a JWT access token for a user."""
        expire = datetime.utcnow() + timedelta(minutes=self.access_token_expire_minutes)

        payload = {
            "sub": user_id,
            "exp": expire,
            "iat": datetime.utcnow(),
            "type": "access",
        }

        if extra_claims:
            payload.update(extra_claims)

        return jwt.encode(payload, self.jwt_secret, algorithm=self.jwt_algorithm)

    def verify_access_token(self, token: str) -> Dict[str, Any]:
        """
        Verify and decode a JWT access token.
        Returns the decoded payload if valid.
        Raises AuthError if invalid.
        """
        try:
            payload = jwt.decode(
                token,
                self.jwt_secret,
                algorithms=[self.jwt_algorithm]
            )

            if payload.get("type") != "access":
                raise AuthError("Invalid token type")

            user_id = payload.get("sub")
            if not user_id:
                raise AuthError("Token missing user ID")

            return payload

        except JWTError as e:
            raise AuthError(f"Invalid token: {str(e)}")

    def get_user_id_from_token(self, token: str) -> str:
        """Extract user ID from a valid token."""
        payload = self.verify_access_token(token)
        return payload["sub"]

    # ==================== Google OAuth ====================

    async def verify_google_token(self, id_token_str: str) -> Dict[str, Any]:
        """
        Verify a Google ID token and return user info.

        Returns dict with:
            - provider_id: Google user ID
            - email: User's email
            - name: User's display name
            - avatar_url: Profile picture URL
        """
        if not self.google_client_id:
            raise AuthError("Google OAuth not configured")

        try:
            # Verify the token with Google
            idinfo = id_token.verify_oauth2_token(
                id_token_str,
                google_requests.Request(),
                self.google_client_id
            )

            # Verify issuer
            if idinfo['iss'] not in ['accounts.google.com', 'https://accounts.google.com']:
                raise AuthError("Invalid token issuer")

            return {
                "provider": "google",
                "provider_id": idinfo["sub"],
                "email": idinfo.get("email"),
                "name": idinfo.get("name"),
                "avatar_url": idinfo.get("picture"),
            }

        except ValueError as e:
            raise AuthError(f"Invalid Google token: {str(e)}")

    # ==================== Apple OAuth ====================

    async def verify_apple_token(self, id_token_str: str) -> Dict[str, Any]:
        """
        Verify an Apple ID token and return user info.

        Apple Sign In flow:
        1. Client gets ID token from Apple
        2. We verify the token with Apple's public keys
        3. Extract user info from verified token

        Returns dict with:
            - provider_id: Apple user ID
            - email: User's email (may be private relay)
            - name: User's display name (only on first login)
        """
        if not self.apple_client_id:
            raise AuthError("Apple OAuth not configured")

        try:
            # Fetch Apple's public keys
            async with httpx.AsyncClient() as client:
                resp = await client.get("https://appleid.apple.com/auth/keys")
                resp.raise_for_status()
                apple_keys = resp.json()

            # Decode token header to get kid
            unverified_header = jwt.get_unverified_header(id_token_str)
            kid = unverified_header.get("kid")

            # Find the matching key
            key = None
            for k in apple_keys.get("keys", []):
                if k.get("kid") == kid:
                    key = k
                    break

            if not key:
                raise AuthError("Apple public key not found")

            # Verify and decode the token
            payload = jwt.decode(
                id_token_str,
                key,
                algorithms=["RS256"],
                audience=self.apple_client_id,
                issuer="https://appleid.apple.com"
            )

            return {
                "provider": "apple",
                "provider_id": payload["sub"],
                "email": payload.get("email"),
                "name": None,  # Apple only sends name on first authorization
                "avatar_url": None,  # Apple doesn't provide avatar
            }

        except JWTError as e:
            raise AuthError(f"Invalid Apple token: {str(e)}")
        except httpx.HTTPError as e:
            raise AuthError(f"Failed to verify Apple token: {str(e)}")


def generate_jwt_secret() -> str:
    """Generate a secure random JWT secret."""
    return secrets.token_urlsafe(32)
