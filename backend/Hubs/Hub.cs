using Microsoft.AspNetCore.SignalR;
using IO_Checkout_Tool.Constants;
using Shared.Library.Models.Entities;
using Shared.Library.DTOs;

namespace IO_Checkout_Tool.Hubs
{
    public class Hub : Microsoft.AspNetCore.SignalR.Hub
    {
        public async Task SendMessage(Io tag)
        {
            await Clients.All.SendAsync(SignalRConstants.HubMethods.RECEIVE_MESSAGE, tag);
        }

        public async Task UpdateIO(IoUpdateDto update)
        {
            await Clients.All.SendAsync("UpdateIO", update.Id, update.Result, update.State, update.Timestamp, update.Comments);
        }
    }
}
