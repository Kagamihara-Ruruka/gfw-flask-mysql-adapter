using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private const uint CredTypeGeneric = 1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(
        string target,
        uint type,
        uint flags,
        out IntPtr credentialPointer);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credentialPointer);

    public static int Main()
    {
        string target = Environment.GetEnvironmentVariable("BDDE38_SSH_CREDENTIAL_TARGET");
        if (String.IsNullOrWhiteSpace(target))
        {
            return 1;
        }

        IntPtr credentialPointer;
        if (!CredRead(target, CredTypeGeneric, 0, out credentialPointer))
        {
            return 2;
        }

        try
        {
            Credential credential = (Credential)Marshal.PtrToStructure(
                credentialPointer,
                typeof(Credential));
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0)
            {
                return 3;
            }

            byte[] bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine(Encoding.Unicode.GetString(bytes));
            return 0;
        }
        finally
        {
            CredFree(credentialPointer);
        }
    }
}
