# Changelog

All notable changes to FoodSnap will be documented in this file.

## [1.1.0] - 2024-01-31

### Added
- **Backend: Unified Error Handling**
  - `ApiError` class for structured error responses
  - Global error handler middleware
  - Consistent error response format with error codes
  
- **Backend: Input Validation**
  - `validateRequired()` helper for required field checking
  - `validateMealType()` for meal type validation
  - `validateRange()` for numeric range validation
  - `sanitizeString()` for XSS prevention

- **Backend: Performance**
  - Cache control headers for static-like endpoints
  - Request timing logging for slow requests (>2s)
  - API version in health endpoint

- **Frontend: Network Resilience**
  - `fetchWithRetry()` for automatic request retries
  - Exponential backoff for failed requests
  - Better error messages for network failures

- **Frontend: Performance**
  - Memory cache system (`getCached`, `setCache`, `clearCache`)
  - `DateUtils` helper with cached formatters
  - Relative time formatting ("3 minutes ago")

- **Frontend: UX**
  - Global loading indicator (`showLoading`, `hideLoading`)
  - Improved toast notifications
  - Better error feedback

- **Documentation**
  - Comprehensive API documentation (API.md)
  - This changelog file

### Changed
- Meals API now returns standardized `successResponse` format
- Health endpoint includes version number
- Config endpoint includes feature flags
- AI analysis errors now show toast instead of alert

### Fixed
- Network errors now trigger retry with backoff
- Large payload handling improved with progressive cleanup
- Date formatting performance improved with cached formatters

## [1.0.0] - 2024-01-20

### Initial Release
- AI food recognition from photos
- Meal logging and tracking
- Daily/weekly nutrition statistics
- User goal setting (cut/bulk/maintain)
- Exercise tracking with screenshot recognition
- Body metrics (weight, body fat) tracking
- Supplement/medication tracking
- AI health insights
- Google OAuth authentication
- Multi-language support (Chinese, English, Japanese)
- Progressive Web App (PWA) support
- Offline-first with localStorage
- Cloud sync with D1 database

---

## Upgrade Guide

### From 1.0.0 to 1.1.0

No breaking changes. The new error response format is backwards compatible:
- Old format: `{ error: "message" }`
- New format: `{ success: false, error: { message: "...", code: "..." } }`

Clients should check for `response.error` or `!response.success` to detect errors.
