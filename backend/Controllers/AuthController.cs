using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using IO_Checkout_Tool.Services;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Controllers;

[ApiController]
[Route("api/auth")]
public class AuthController : ControllerBase
{
    private readonly IAuthService _authService;
    private readonly IJwtTokenService _jwtTokenService;
    private readonly ILogger<AuthController> _logger;

    public AuthController(IAuthService authService, IJwtTokenService jwtTokenService, ILogger<AuthController> logger)
    {
        _authService = authService;
        _jwtTokenService = jwtTokenService;
        _logger = logger;
    }

    [EnableRateLimiting("AuthRateLimit")]
    [HttpPost("login")]
    public async Task<ActionResult<object>> Login([FromBody] LoginRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.FullName) || string.IsNullOrWhiteSpace(request.Pin))
        {
            return BadRequest(new { message = "Full name and PIN are required" });
        }

        var (success, user, message) = await _authService.ValidateLoginAsync(request.FullName, request.Pin);

        if (!success || user == null)
        {
            return Unauthorized(new { message });
        }

        var token = _jwtTokenService.GenerateToken(user);

        return Ok(new
        {
            fullName = user.FullName,
            isAdmin = user.IsAdmin,
            loginTime = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss"),
            token
        });
    }
}

public class LoginRequest
{
    public string FullName { get; set; } = string.Empty;
    public string Pin { get; set; } = string.Empty;
}

