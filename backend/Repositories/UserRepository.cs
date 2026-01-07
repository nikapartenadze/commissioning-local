using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Models;

namespace IO_Checkout_Tool.Repositories;

public interface IUserRepository
{
    Task<User?> GetByIdAsync(int id);
    Task<User?> GetByFullNameAsync(string fullName);
    Task<IEnumerable<User>> GetAllAsync();
    Task<IEnumerable<User>> GetActiveUsersAsync();
    Task<User> CreateAsync(User user);
    Task<User> UpdateAsync(User user);
    Task<bool> DeleteAsync(int id);
    Task<bool> FullNameExistsAsync(string fullName);
}

public class UserRepository : BaseRepository<User>, IUserRepository
{
    public UserRepository(TagsContext context) : base(context)
    {
    }

    public async Task<User?> GetByFullNameAsync(string fullName)
    {
        return await _dbSet.FirstOrDefaultAsync(u => u.FullName == fullName);
    }

    public async Task<IEnumerable<User>> GetAllAsync()
    {
        return await _dbSet.ToListAsync();
    }

    public async Task<IEnumerable<User>> GetActiveUsersAsync()
    {
        return await _dbSet.Where(u => u.IsActive).ToListAsync();
    }

    public async Task<User> CreateAsync(User user)
    {
        return await AddAsync(user);
    }

    public async Task<bool> FullNameExistsAsync(string fullName)
    {
        return await _dbSet.AnyAsync(u => u.FullName == fullName);
    }
}

