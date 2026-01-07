using Microsoft.EntityFrameworkCore;
using IO_Checkout_Tool.Constants;
using IO_Checkout_Tool.Services.Interfaces;
using IO_Checkout_Tool.Models;
using Shared.Library.Models.Entities;

namespace IO_Checkout_Tool.Services;

public class GraphDataService : IGraphDataService
{
    private readonly IDbContextFactory<TagsContext> _dbFactory;
    private readonly IAppStateService _appStateService;

    public GraphDataService(IDbContextFactory<TagsContext> dbFactory, IAppStateService appStateService)
    {
        _dbFactory = dbFactory;
        _appStateService = appStateService;
    }

    public async Task UpdateGraphDataAsync()
    {
        using var db = _dbFactory.CreateDbContext();
        var list = await db.Ios.ToListAsync();

        var totalCount = list.Count(x => (!x.Description.Contains("SPARE") && 
                                          x.Description != TestConstants.DESC_INPUT && 
                                          x.Description != TestConstants.DESC_OUTPUT) || 
                                         x.Result == TestConstants.RESULT_FAILED);
                                         
        var passedCount = list.Count(x => x.Result == TestConstants.RESULT_PASSED);
        var failedCount = list.Count(x => x.Result == TestConstants.RESULT_FAILED);
        var notTestedCount = list.Count(x => !x.Description.Contains("SPARE") && 
                                             x.Description != TestConstants.DESC_INPUT && 
                                             x.Description != TestConstants.DESC_OUTPUT && 
                                             (x.Result == null || x.Result == string.Empty));

        _appStateService.GraphState.UpdateData(passedCount, failedCount, notTestedCount, totalCount);
    }
} 