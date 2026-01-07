using IO_Checkout_Tool.Models;
using IO_Checkout_Tool.Repositories;
using Microsoft.Extensions.Logging;

namespace IO_Checkout_Tool.Services;

public interface IAuthService
{
    Task<(bool Success, User? User, string Message)> ValidateLoginAsync(string fullName, string pin);
    string HashPin(string pin);
    bool VerifyPin(string pin, string hashedPin);
}

public class AuthService : IAuthService
{
    private readonly IUserRepository _userRepository;
    private readonly ILogger<AuthService> _logger;

    public AuthService(IUserRepository userRepository, ILogger<AuthService> logger)
    {
        _userRepository = userRepository;
        _logger = logger;
    }

    public async Task<(bool Success, User? User, string Message)> ValidateLoginAsync(string fullName, string pin)
    {
        try
        {
            var user = await _userRepository.GetByFullNameAsync(fullName);

            if (user == null)
            {
                _logger.LogWarning("Login attempt for non-existent user: {FullName}", fullName);
                return (false, null, "User not found");
            }

            if (!user.IsActive)
            {
                _logger.LogWarning("Login attempt for inactive user: {FullName}", fullName);
                return (false, null, "User account is inactive");
            }

            if (!VerifyPin(pin, user.Pin))
            {
                _logger.LogWarning("Invalid PIN for user: {FullName}", fullName);
                return (false, null, "Invalid PIN");
            }

            // Update last used timestamp
            user.LastUsedAt = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss");
            await _userRepository.UpdateAsync(user);

            _logger.LogInformation("User logged in successfully: {FullName}", fullName);
            return (true, user, "Login successful");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during login validation for user: {FullName}", fullName);
            return (false, null, "An error occurred during login");
        }
    }

    public string HashPin(string pin)
    {
        // Using BCrypt for PIN hashing
        return BCrypt.Net.BCrypt.HashPassword(pin);
    }

    public bool VerifyPin(string pin, string hashedPin)
    {
        try
        {
            return BCrypt.Net.BCrypt.Verify(pin, hashedPin);
        }
        catch
        {
            return false;
        }
    }
}

