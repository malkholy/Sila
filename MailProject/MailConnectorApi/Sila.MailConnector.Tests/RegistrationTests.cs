using Sila.MailConnector.Sync;
using Xunit;

namespace Sila.MailConnector.Tests;

public sealed class RegistrationTests
{
    private static readonly ExchangeOptions Settings = new() { AllowedDomains = ["glcpaints.com", "glc.local"] };

    [Theory]
    [InlineData("m.elkholy@glcpaints.com")]
    [InlineData("M.Elkholy@GLCPaints.com")]      // case does not matter
    [InlineData("admin@glc.local")]
    public void An_address_in_an_allowed_domain_is_accepted(string email) =>
        Assert.Null(MailboxRegistration.CheckAddress(email, Settings));

    [Theory]
    [InlineData("someone@gmail.com", "not an allowed mail domain")]
    [InlineData("m.elkholy@glcpaints.com.evil.test", "not an allowed mail domain")]
    [InlineData("not-an-address", "valid email address")]
    [InlineData("a@glcpaints.com, b@glcpaints.com", "valid email address")]
    [InlineData("Mona <mona@glcpaints.com>", "valid email address")]   // the address only, no display part
    [InlineData("", "valid email address")]
    [InlineData(null, "valid email address")]
    public void Anything_else_is_refused_with_a_reason(string? email, string reason) =>
        Assert.Contains(reason, MailboxRegistration.CheckAddress(email, Settings));
}
