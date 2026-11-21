param(
  [Parameter(Mandatory)][string]$ExtractedDictionary,
  [Parameter(Mandatory)][string]$Output
)
$ErrorActionPreference = 'Stop'
$words = [Collections.Generic.Dictionary[string,object[]]]::new([StringComparer]::Ordinal)
$nounDefinition = '../pos_info[pos="명사"]//sense_info[type="일반어" and not(cat_info)]/definition'
$shards = @(Get-ChildItem -LiteralPath $ExtractedDictionary -Recurse -Filter '*.xml' -File)
if (!$shards.Count) { throw 'No Standard Korean Dictionary XML shards found' }

foreach ($shard in $shards) {
  $doc = [Xml.XmlDocument]::new()
  $doc.Load($shard.FullName)
  $nodes = $doc.SelectNodes('/channel/item/word_info[word_unit="단어" and pos_info[pos="명사" and .//sense_info[type="일반어" and not(cat_info)]]]/word')
  foreach ($node in $nodes) {
    $word = $node.InnerText.Normalize() -creplace '(?<=[가-힣])-(?=[가-힣])', ''
    if ($word -cnotmatch '^[가-힣]{3,4}$' -or $words.ContainsKey($word)) { continue }
    $definition = $node.SelectSingleNode($nounDefinition)?.InnerText
    $code = $node.SelectSingleNode('../../target_code')?.InnerText
    $words[$word] = @($code, $definition)
  }
}

$sorted = [string[]]@($words.Keys)
[Array]::Sort($sorted, [StringComparer]::Ordinal)
$writer = [IO.StreamWriter]::new([IO.Path]::GetFullPath($Output), $false, [Text.UTF8Encoding]::new($false))
try {
  foreach ($word in $sorted) {
    $writer.WriteLine((ConvertTo-Json -Compress -InputObject (@($word) + $words[$word])))
  }
} finally { $writer.Dispose() }
$sorted | Group-Object Length | Select-Object Name,Count
