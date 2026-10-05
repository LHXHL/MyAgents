# $path is supplied by Rust as base64-decoded UTF-8, never interpolated as code.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    # Load and modify only Access. Set-Acl copies the entire descriptor and can
    # request SeSecurityPrivilege for Audit even when the file's DACL is correct.
    $acl = [Security.AccessControl.FileSecurity]::new($path, [Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
    $acl.SetAccessRule($rule)
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        [IO.File]::SetAccessControl($path, $acl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($path), $acl)
    }
} catch {
    $cause = $_.Exception
    while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
    # ASCII metadata only: never emit paths, credential data, CLIXML or raw text.
    [Console]::Error.WriteLine('ACL_WRITE_FAILED type=' + $cause.GetType().FullName + ' hresult=' + $cause.HResult)
    exit 1
}
