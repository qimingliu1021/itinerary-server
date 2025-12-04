# itinerary-server

curl -X POST https://api.brightdata.com/request \
 -H "Content-Type: application/json" \
 -H "Authorization: Bearer 6459d39d36851ebd99bcba9714046d72017ca3976226041700c8dc1e5da12cf8" \
 -d '{
"zone": "serp_api1",
"url": "https://www.google.com/search?q=pizza&hl=en&gl=us",
"format": "raw"
}'

## serp_api1

curl https://api.brightdata.com/request -H "Content-Type: application/json" -H "Authorization: Bearer 6459d39d36851ebd99bcba9714046d72017ca3976226041700c8dc1e5da12cf8" -d "{\"zone\": \"serp_api1\",\"url\": \"https://www.google.com/search?q=pizza\", \"format\": \"raw\"}"

liuqiming@Qiming-macpro2021-14 itinerary-server % curl -I "https://mcp.brightdata.com/sse?token=${YOUR_KEY}&pro=1"
HTTP/2 404
server: nginx
date: Thu, 04 Dec 2025 00:35:47 GMT

curl -I "https://mcp.brightdata.com/sse?token=${6459d39d36851ebd99bcba9714046d72017ca3976226041700c8dc1e5da12cf8}&pro=1"
