using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Authorization;
using IO_Checkout_Tool.Models;
using IO_Checkout_Tool.Repositories;
using IO_Checkout_Tool.Services;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Controllers;

[Authorize]
[ApiController]
[Route("api/users")]
public class UserController : ControllerBase
{
    private readonly IUserRepository _userRepository;
    private readonly IAuthService _authService;
    private readonly ILogger<UserController> _logger;

    public UserController(
        IUserRepository userRepository,
        IAuthService authService,
        ILogger<UserController> logger)
    {
        _userRepository = userRepository;
        _authService = authService;
        _logger = logger;
    }

    [HttpGet]
    public async Task<ActionResult<IEnumerable<object>>> GetUsers()
    {
        try
        {
            var users = await _userRepository.GetAllAsync();
            
            return Ok(users.Select(u => new
            {
                id = u.Id,
                fullName = u.FullName,
                isAdmin = u.IsAdmin,
                isActive = u.IsActive,
                createdAt = u.CreatedAt,
                lastUsedAt = u.LastUsedAt
            }));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting users");
            return StatusCode(500, new { message = "Error retrieving users" });
        }
    }

    [AllowAnonymous]
    [HttpGet("active")]
    public async Task<ActionResult<IEnumerable<object>>> GetActiveUsers()
    {
        try
        {
            var users = await _userRepository.GetActiveUsersAsync();
            
            return Ok(users.Select(u => new
            {
                id = u.Id,
                fullName = u.FullName,
                isAdmin = u.IsAdmin
            }));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting active users");
            return StatusCode(500, new { message = "Error retrieving active users" });
        }
    }

    [HttpPost]
    public async Task<ActionResult<object>> CreateUser([FromBody] CreateUserRequest request)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(request.FullName))
            {
                return BadRequest(new { message = "Full name is required" });
            }

            if (string.IsNullOrWhiteSpace(request.Pin) || request.Pin.Length != 6)
            {
                return BadRequest(new { message = "PIN must be exactly 6 digits" });
            }

            // Check if user already exists
            if (await _userRepository.FullNameExistsAsync(request.FullName))
            {
                return BadRequest(new { message = "A user with this name already exists" });
            }

            // Check if PIN is already in use by another user
            var allUsers = await _userRepository.GetAllAsync();
            foreach (var existingUser in allUsers)
            {
                if (_authService.VerifyPin(request.Pin, existingUser.Pin))
                {
                    return BadRequest(new { message = "This PIN is already in use by another user. Please choose a different PIN." });
                }
            }

            var hashedPin = _authService.HashPin(request.Pin);

            var user = new User
            {
                FullName = request.FullName,
                Pin = hashedPin,
                IsAdmin = false,
                IsActive = true,
                CreatedAt = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss")
            };

            var createdUser = await _userRepository.CreateAsync(user);

            _logger.LogInformation("User created: {FullName} by {CreatedBy}", request.FullName, request.CreatedByAdmin);

            return Ok(new
            {
                id = createdUser.Id,
                fullName = createdUser.FullName,
                message = "User created successfully"
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating user");
            return StatusCode(500, new { message = "Error creating user" });
        }
    }

    [HttpPut("{id}/reset-pin")]
    public async Task<ActionResult<object>> ResetPin(int id, [FromBody] ResetPinRequest request)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(request.NewPin) || request.NewPin.Length != 6)
            {
                return BadRequest(new { message = "PIN must be exactly 6 digits" });
            }

            var user = await _userRepository.GetByIdAsync(id);
            if (user == null)
            {
                return NotFound(new { message = "User not found" });
            }

            // Check if new PIN is already in use by another user
            var allUsers = await _userRepository.GetAllAsync();
            foreach (var existingUser in allUsers)
            {
                // Skip the current user being updated
                if (existingUser.Id != id && _authService.VerifyPin(request.NewPin, existingUser.Pin))
                {
                    return BadRequest(new { message = "This PIN is already in use by another user. Please choose a different PIN." });
                }
            }

            user.Pin = _authService.HashPin(request.NewPin);
            await _userRepository.UpdateAsync(user);

            _logger.LogInformation("PIN reset for user: {FullName} by {ResetBy}", user.FullName, request.ResetByAdmin);

            return Ok(new { message = "PIN reset successfully" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error resetting PIN for user {UserId}", id);
            return StatusCode(500, new { message = "Error resetting PIN" });
        }
    }

    [HttpPut("{id}/toggle-active")]
    public async Task<ActionResult<object>> ToggleActive(int id)
    {
        try
        {
            var user = await _userRepository.GetByIdAsync(id);
            if (user == null)
            {
                return NotFound(new { message = "User not found" });
            }

            // Prevent deactivating any admin
            if (user.IsAdmin)
            {
                return BadRequest(new { message = "Cannot deactivate admin accounts" });
            }

            user.IsActive = !user.IsActive;
            await _userRepository.UpdateAsync(user);

            _logger.LogInformation("User {FullName} {Action}", user.FullName, user.IsActive ? "activated" : "deactivated");

            return Ok(new
            {
                isActive = user.IsActive,
                message = user.IsActive ? "User activated" : "User deactivated"
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error toggling active status for user {UserId}", id);
            return StatusCode(500, new { message = "Error updating user status" });
        }
    }

    [HttpDelete("{id}")]
    public async Task<ActionResult<object>> DeleteUser(int id)
    {
        try
        {
            var user = await _userRepository.GetByIdAsync(id);
            if (user == null)
            {
                return NotFound(new { message = "User not found" });
            }

            // Prevent deleting any admin
            if (user.IsAdmin)
            {
                return BadRequest(new { message = "Cannot delete admin accounts" });
            }

            await _userRepository.DeleteAsync(id);

            _logger.LogInformation("User deleted: {FullName}", user.FullName);

            return Ok(new { message = "User deleted successfully" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting user {UserId}", id);
            return StatusCode(500, new { message = "Error deleting user" });
        }
    }
}

public class CreateUserRequest
{
    public string FullName { get; set; } = string.Empty;
    public string Pin { get; set; } = string.Empty;
    public string CreatedByAdmin { get; set; } = string.Empty;
}

public class ResetPinRequest
{
    public string NewPin { get; set; } = string.Empty;
    public string ResetByAdmin { get; set; } = string.Empty;
}

