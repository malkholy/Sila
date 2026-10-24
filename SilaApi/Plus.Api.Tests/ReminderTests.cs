using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Plus.Api.Live;
using Plus.Api.Push;
using Xunit;

namespace Plus.Api.Tests;

public sealed class ReminderTests
{
    private sealed class FakeReminderStore(params DueReminder[] items) : IReminderStore
    {
        public Task<IReadOnlyList<DueReminder>> ClaimDueAsync(int top, int maxAgeMinutes, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<DueReminder>>(items);
    }

    private sealed class StaticOptions(PushOptions value) : IOptionsMonitor<PushOptions>
    {
        public PushOptions CurrentValue => value;
        public PushOptions Get(string? name) => value;
        public IDisposable? OnChange(Action<PushOptions, string?> listener) => null;
    }

    private static DueReminder Due(int id, bool late = false, bool push = true, string linkKind = "", int linkId = 0, params string[] tokens) =>
        new(id, 4, "mhd", "Vendor code", "Ask Finance", new DateTime(2026, 10, 24, 14, 0, 0), late, push, linkKind, linkId, 0, tokens);

    private static ReminderSender Sender(IReminderStore store, FakePushStore tokens, FakeTransport transport) =>
        new(store, tokens, transport, new LiveHub(NullLogger<LiveHub>.Instance),
            new StaticOptions(new PushOptions { Enabled = true }), NullLogger<ReminderSender>.Instance);

    [Fact]
    public void Payload_opens_the_linked_conversation()
    {
        var m = ReminderSender.Message(Due(9, linkKind: "ticket", linkId: 2301855), "tok");
        Assert.Equal("Reminder · 14:00", m["notification"]!["title"]!.GetValue<string>());
        Assert.Equal("Vendor code\nAsk Finance", m["notification"]!["body"]!.GetValue<string>());
        Assert.Equal("3", m["data"]!["ChatType"]!.GetValue<string>());
        Assert.Equal("2301855", m["data"]!["TicketID"]!.GetValue<string>());
        Assert.Equal("9", m["data"]!["ReminderID"]!.GetValue<string>());
        // a reminder with no link opens the notifications screen
        Assert.Equal("6", ReminderSender.Message(Due(1), "tok")["data"]!["ChatType"]!.GetValue<string>());
        Assert.Equal("1", ReminderSender.Message(Due(2, linkKind: "chat", linkId: 77), "tok")["data"]!["ChatType"]!.GetValue<string>());
    }

    [Fact]
    public async Task Pushes_due_reminders_but_not_late_or_silent_ones()
    {
        var transport = new FakeTransport(_ => PushResult.Sent);
        var store = new FakeReminderStore(Due(1, tokens: "a"), Due(2, late: true, tokens: "b"), Due(3, push: false, tokens: "c"));
        var fired = await Sender(store, new FakePushStore(), transport).Tick(CancellationToken.None);
        Assert.Equal(3, fired);
        Assert.Equal(["a"], transport.Sent.Select(m => m["token"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Gone_tokens_are_removed()
    {
        var transport = new FakeTransport(t => t == "old" ? PushResult.TokenGone : PushResult.Sent);
        var tokens = new FakePushStore();
        await Sender(new FakeReminderStore(Due(1, tokens: ["new", "old"])), tokens, transport).Tick(CancellationToken.None);
        Assert.Equal(["old"], tokens.Removed);
    }

    [Fact]
    public void Live_frame_carries_the_reminder()
    {
        var frame = System.Text.Json.JsonSerializer.Serialize(ReminderSender.LiveFrame(Due(5, linkKind: "group", linkId: 590)));
        Assert.Contains("\"type\":\"reminder\"", frame);
        Assert.Contains("\"linkKind\":\"group\"", frame);
        Assert.Contains("\"dueAt\":\"2026-10-24T14:00:00\"", frame);
    }
}
